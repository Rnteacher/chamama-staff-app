-- ============================================================================
-- Migration 20260916000003: PRIMARY MASTER + NOTIFICATION CLAIM
--
-- Pre-production correctness pass:
--
-- 1. PRIMARY PROJECT MASTER
--    master_assignments gains is_primary (default false) with a partial
--    unique index — at most ONE primary master per student. The coordinator
--    assignment (coordinator_set_master) REPLACES the previous primary
--    while preserving manually-added secondary (is_primary = false) rows.
--    Existing rows keep is_primary = false → fully backward compatible.
--
-- 2. ATOMIC PUSH CLAIM
--    meeting_occurrences gains notify_started_at (a claim/lease stamp).
--    claim_due_meeting_occurrences() atomically claims due, un-notified,
--    un-claimed (or lease-expired) occurrences using FOR UPDATE SKIP LOCKED
--    — two concurrent dispatchers can never own the same occurrence.
--    submit_meeting_report is replaced to also clear the claim on reschedule.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. canonical primary master
-- ---------------------------------------------------------------------------
alter table public.master_assignments
  add column if not exists is_primary boolean not null default false;

-- one current project has at most one primary master
create unique index if not exists master_assignments_single_primary
  on public.master_assignments (student_id)
  where is_primary;

-- ---------------------------------------------------------------------------
-- coordinator_set_master: replace the previous primary master atomically.
--   * the previous PRIMARY row is removed (it was coordinator-created)
--   * manually-added secondary rows (is_primary = false) survive untouched
--   * if the new primary already exists as a secondary row, that row is
--     promoted to primary
--   * same master twice → idempotent
-- ---------------------------------------------------------------------------
create or replace function public.coordinator_set_master(
  p_submission_id uuid,
  p_master_staff_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff  uuid := public.current_staff_id();
  v_sub    public.intake_submissions;
  v_prev   uuid;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Only a project coordinator or super_admin can assign masters'
      using errcode = '42501';
  end if;

  select * into v_sub from public.intake_submissions where id = p_submission_id;
  if v_sub.id is null then
    raise exception 'Submission not found';
  end if;

  -- assigned master must be active staff (pre-login staff identities are fine)
  if p_master_staff_id is null or not exists (
    select 1 from public.profiles p where p.id = p_master_staff_id and p.is_active
  ) then
    raise exception 'Assigned master must be an active staff member';
  end if;

  -- the student's current project (one per student)
  insert into public.student_projects (student_id, intent_text, major_id)
  values (v_sub.student_id, v_sub.intent_text, v_sub.major_id)
  on conflict (student_id) do update
    set intent_text = excluded.intent_text,
        major_id    = excluded.major_id,
        updated_at  = now();

  -- remember the previous primary for the audit trail
  select staff_id into v_prev
    from public.master_assignments
   where student_id = v_sub.student_id
     and is_primary;

  -- replace the previous coordinator-selected primary (deleting its row so
  -- the former primary does not retain access from the obsolete selection).
  -- Manually-added secondary rows (is_primary = false) are NOT touched.
  delete from public.master_assignments
   where student_id = v_sub.student_id
     and is_primary;

  -- promote/insert the new primary (idempotent for the same master)
  insert into public.master_assignments (student_id, staff_id, is_primary)
  values (v_sub.student_id, p_master_staff_id, true)
  on conflict (student_id, staff_id) do update
    set is_primary = true;

  update public.intake_submissions
     set assigned_master_staff_id = p_master_staff_id,
         assigned_by_staff_id     = v_staff,
         assigned_at              = now(),
         updated_at               = now()
   where id = v_sub.id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'intake_master_assigned', 'intake_submission', v_sub.id,
          jsonb_build_object(
            'student_id', v_sub.student_id,
            'master_staff_id', p_master_staff_id,
            'replaced_master_staff_id', v_prev,
            'requested_master_staff_id', v_sub.requested_master_staff_id
          ));

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. atomic notification claim
-- ---------------------------------------------------------------------------
alter table public.meeting_occurrences
  add column if not exists notify_started_at timestamptz;

-- Atomically claim due, un-notified, un-claimed (or lease-expired)
-- occurrences. FOR UPDATE SKIP LOCKED guarantees two concurrent dispatchers
-- can never claim the same row; the lease (notify_started_at older than the
-- lease period) makes a crashed dispatcher's claim retryable.
create or replace function public.claim_due_meeting_occurrences(
  p_limit int default 50
)
returns table (
  occurrence_id uuid,
  student_id    uuid,
  staff_id      uuid,
  first_name    text
)
language sql
volatile
security definer
set search_path = public
as $$
  with due as (
    select o.id, o.schedule_id
      from public.meeting_occurrences o
      join public.meeting_schedules s on s.id = o.schedule_id and s.is_active
      join public.profiles p on p.id = s.staff_id and p.is_active
     where o.notified_at is null
       and (o.notify_started_at is null
            or o.notify_started_at < now() - interval '60 seconds')
       and o.due_at >= now() - interval '1 hour'
       and o.due_at <= now() + interval '15 minutes'
     order by o.due_at
     for update of o skip locked
     limit p_limit
  )
  update public.meeting_occurrences o
     set notify_started_at = now()
    from due
    join public.meeting_schedules s on s.id = due.schedule_id
    join public.students st on st.id = s.student_id
   where o.id = due.id
  returning o.id, s.student_id, s.staff_id, st.first_name;
$$;

-- reschedule must also clear an active claim (re-arm safely)
create or replace function public.submit_meeting_report(
  p_occurrence_id uuid,
  p_held boolean,
  p_not_held_reason text,
  p_reschedule_to timestamptz,
  p_status text,
  p_intervention boolean,
  p_categories text[],
  p_detail_functional text,
  p_detail_emotional text,
  p_detail_other text,
  p_next_steps text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_occ public.meeting_occurrences;
  v_sched public.meeting_schedules;
  v_rescheduled boolean := false;
  v_report_id uuid;
  v_new_week_start date;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into v_occ from public.meeting_occurrences where id = p_occurrence_id;
  if v_occ.id is null then
    raise exception 'Occurrence not found';
  end if;
  select * into v_sched from public.meeting_schedules where id = v_occ.schedule_id;
  if v_sched.staff_id <> v_staff then
    raise exception 'Only the schedule owner can report this meeting' using errcode = '42501';
  end if;

  if p_status not in ('green', 'yellow', 'red') then
    raise exception 'Invalid student status' using errcode = '23514';
  end if;

  if not p_held and (p_not_held_reason is null or length(btrim(p_not_held_reason)) = 0) then
    raise exception 'A reason is required when the meeting did not take place' using errcode = '23514';
  end if;
  if p_held and (p_next_steps is null or length(btrim(p_next_steps)) = 0) then
    raise exception 'Next steps are required for a held meeting' using errcode = '23514';
  end if;

  if p_intervention then
    if p_categories is null or array_length(p_categories, 1) is null then
      raise exception 'Select at least one intervention category' using errcode = '23514';
    end if;
    if 'functional' = any(p_categories) and (p_detail_functional is null or length(btrim(p_detail_functional)) = 0) then
      raise exception 'Functional detail is required' using errcode = '23514';
    end if;
    if 'emotional' = any(p_categories) and (p_detail_emotional is null or length(btrim(p_detail_emotional)) = 0) then
      raise exception 'Emotional detail is required' using errcode = '23514';
    end if;
    if 'other' = any(p_categories) and (p_detail_other is null or length(btrim(p_detail_other)) = 0) then
      raise exception 'Other detail is required' using errcode = '23514';
    end if;
  end if;

  -- optional same-school-week reschedule (only for a not-held meeting)
  if not p_held and p_reschedule_to is not null then
    v_new_week_start := ((p_reschedule_to at time zone 'Asia/Jerusalem')::date
                         - extract(dow from (p_reschedule_to at time zone 'Asia/Jerusalem'))::int);
    if v_new_week_start <> v_occ.week_start then
      raise exception 'Rescheduling is allowed only within the same school week'
        using errcode = '23514';
    end if;
    if p_reschedule_to < now() - interval '1 minute' then
      raise exception 'The new meeting time must be in the future' using errcode = '23514';
    end if;
  end if;

  insert into public.meeting_reports
    (occurrence_id, schedule_id, staff_id, student_id, held, not_held_reason,
     rescheduled_to, status, intervention, intervention_categories,
     intervention_functional, intervention_emotional, intervention_other, next_steps)
  values
    (v_occ.id, v_sched.id, v_staff, v_sched.student_id, p_held,
     case when p_held then null else btrim(p_not_held_reason) end,
     case when (not p_held and p_reschedule_to is not null) then p_reschedule_to else null end,
     p_status, p_intervention,
     case when p_intervention then coalesce(p_categories, '{}') else '{}' end,
     case when p_intervention and 'functional' = any(coalesce(p_categories, '{}')) then btrim(p_detail_functional) end,
     case when p_intervention and 'emotional'  = any(coalesce(p_categories, '{}')) then btrim(p_detail_emotional) end,
     case when p_intervention and 'other'      = any(coalesce(p_categories, '{}')) then btrim(p_detail_other) end,
     case when p_held then btrim(p_next_steps) else nullif(btrim(coalesce(p_next_steps, '')), '') end)
  returning id into v_report_id;

  if not p_held and p_reschedule_to is not null then
    update public.meeting_occurrences
       set due_at = p_reschedule_to,
           notified_at = null,       -- re-arm the reminder for the new time
           notify_started_at = null  -- clear any claim (safe re-arm)
     where id = v_occ.id;
    v_rescheduled := true;
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff,
          case when v_rescheduled then 'meeting_report_rescheduled' else 'meeting_report_submitted' end,
          'meeting_report', v_report_id,
          jsonb_build_object('student_id', v_sched.student_id, 'occurrence_id', v_occ.id,
                             'held', p_held, 'status', p_status, 'intervention', p_intervention));

  return v_report_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
revoke all on function public.claim_due_meeting_occurrences(int) from public, anon, authenticated;
grant execute on function public.claim_due_meeting_occurrences(int) to service_role;
