-- ============================================================================
-- Migration 20260918000001: MEETING REPORTS LIFECYCLE + FEED + DASHBOARDS v3
--
-- Part A database layer:
--   * meeting_reports: soft delete (deleted_at), canonical meeting_at,
--     relationship context (mentor|master), ad-hoc reports
--     (occurrence_id nullable, partial unique index for linked reports)
--   * submit_meeting_report: stamps meeting_at from the occurrence
--   * submit_adhoc_meeting_report: report at ANY time without an occurrence
--       (meeting_at provided, Asia/Jerusalem default applied client-side)
--   * delete_meeting_report: audited soft delete (owner or super_admin)
--   * student_feed_items: unified student timeline
--     (messages + meeting reports + form submissions placeholder-ready)
--   * dashboard_rows v3: archived/deleted excluded, mentor vs master
--     separation (last/next per context), canonical status by meeting_at
--   * intake_windows: archived_at soft state
-- ============================================================================

-- ---------------------------------------------------------------------------
-- meeting_reports lifecycle columns
-- ---------------------------------------------------------------------------
alter table public.meeting_reports
  add column if not exists deleted_at timestamptz;
alter table public.meeting_reports
  add column if not exists meeting_at timestamptz;
alter table public.meeting_reports
  add column if not exists context text;

-- backfill canonical meeting time + relationship context for existing rows
update public.meeting_reports r
   set meeting_at = o.due_at,
       context    = s.context
  from public.meeting_occurrences o
  join public.meeting_schedules s on s.id = o.schedule_id
 where r.occurrence_id = o.id
   and (r.meeting_at is null or r.context is null);

-- every historical report is occurrence-linked, so meeting_at is complete
alter table public.meeting_reports alter column meeting_at set not null;
alter table public.meeting_reports alter column meeting_at set default now();
alter table public.meeting_reports alter column context set default 'mentor';

-- occurrence link becomes OPTIONAL (ad-hoc reports): replace the strict
-- unique constraint with a partial unique index (NULLs unconstrained)
alter table public.meeting_reports
  alter column occurrence_id drop not null;
alter table public.meeting_reports
  alter column schedule_id drop not null;
alter table public.meeting_reports
  drop constraint if exists meeting_reports_occurrence_id_key;
create unique index if not exists meeting_reports_occurrence_unique
  on public.meeting_reports (occurrence_id)
  where occurrence_id is not null;

create index if not exists idx_meeting_reports_student_meeting
  on public.meeting_reports (student_id, meeting_at desc);

-- ---------------------------------------------------------------------------
-- ad-hoc meeting report: authorized mentor/master reports at ANY time
-- (meeting_at defaults handled client-side as Asia/Jerusalem "now"; the
--  server validates it is a sane historical/imminent instant)
-- ---------------------------------------------------------------------------
create or replace function public.submit_adhoc_meeting_report(
  p_student_id uuid,
  p_context text,
  p_meeting_at timestamptz,
  p_held boolean,
  p_not_held_reason text,
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
  v_report_id uuid;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_context not in ('mentor', 'master') then
    raise exception 'Invalid meeting context' using errcode = '23514';
  end if;
  -- authorization: mentor relationship OR master relationship (super_admin
  -- keeps its existing broader management ability)
  if not (
    (p_context = 'mentor' and public.is_student_mentor(v_staff, p_student_id))
    or (p_context = 'master' and public.is_assigned_master(v_staff, p_student_id))
    or public.staff_has_role(v_staff, 'super_admin')
  ) then
    raise exception 'Not authorized to report meetings for this student'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.students s where s.id = p_student_id and not s.is_archived) then
    raise exception 'Student not found' using errcode = '23514';
  end if;

  -- meeting_at is required and must be a sane historical/imminent instant
  if p_meeting_at is null
     or p_meeting_at > now() + interval '1 hour'
     or p_meeting_at < now() - interval '180 days' then
    raise exception 'Invalid meeting time' using errcode = '23514';
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

  insert into public.meeting_reports
    (occurrence_id, schedule_id, staff_id, student_id, context, meeting_at,
     held, not_held_reason, status, intervention, intervention_categories,
     intervention_functional, intervention_emotional, intervention_other, next_steps)
  values
    (null, null, v_staff, p_student_id, p_context, p_meeting_at,
     p_held, case when p_held then null else btrim(p_not_held_reason) end,
     p_status, p_intervention,
     case when p_intervention then coalesce(p_categories, '{}') else '{}' end,
     case when p_intervention and 'functional' = any(coalesce(p_categories, '{}')) then btrim(p_detail_functional) end,
     case when p_intervention and 'emotional'  = any(coalesce(p_categories, '{}')) then btrim(p_detail_emotional) end,
     case when p_intervention and 'other'      = any(coalesce(p_categories, '{}')) then btrim(p_detail_other) end,
     case when p_held then btrim(p_next_steps) else nullif(btrim(coalesce(p_next_steps, '')), '') end)
  returning id into v_report_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'meeting_report_submitted', 'meeting_report', v_report_id,
          jsonb_build_object('student_id', p_student_id, 'ad_hoc', true,
                             'context', p_context, 'held', p_held, 'status', p_status));

  return v_report_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- audited soft delete (owner of the report or super_admin)
-- ---------------------------------------------------------------------------
create or replace function public.delete_meeting_report(p_report_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_report public.meeting_reports;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into v_report from public.meeting_reports where id = p_report_id;
  if v_report.id is null or v_report.deleted_at is not null then
    raise exception 'Report not found';
  end if;
  if v_report.staff_id <> v_staff and not public.staff_has_role(v_staff, 'super_admin') then
    raise exception 'Only the reporter or a super_admin can delete a report'
      using errcode = '42501';
  end if;

  update public.meeting_reports
     set deleted_at = now(), updated_at = now()
   where id = v_report.id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'meeting_report_deleted', 'meeting_report', v_report.id,
          jsonb_build_object('student_id', v_report.student_id,
                             'meeting_at', v_report.meeting_at,
                             'status', v_report.status));

  return true;
end;
$$;

grant execute on function public.submit_adhoc_meeting_report(uuid, text, timestamptz, boolean, text, text, boolean, text[], text, text, text, text) to authenticated;
revoke all on function public.submit_adhoc_meeting_report(uuid, text, timestamptz, boolean, text, text, boolean, text[], text, text, text, text) from public, anon;
grant execute on function public.delete_meeting_report(uuid) to authenticated;
revoke all on function public.delete_meeting_report(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- submit_meeting_report: stamp canonical meeting_at from the occurrence
-- ---------------------------------------------------------------------------
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
    (occurrence_id, schedule_id, staff_id, student_id, context, meeting_at,
     held, not_held_reason, rescheduled_to, status, intervention,
     intervention_categories, intervention_functional, intervention_emotional,
     intervention_other, next_steps)
  values
    (v_occ.id, v_sched.id, v_staff, v_sched.student_id, v_sched.context,
     v_occ.due_at, -- canonical: when the meeting was scheduled to happen
     p_held, case when p_held then null else btrim(p_not_held_reason) end,
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
           notified_at = null,
           notify_started_at = null
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
-- unified student feed: messages + meeting reports (+ form submissions later)
-- ---------------------------------------------------------------------------
create or replace function public.student_feed_items(p_student_id uuid)
returns table (
  item_id    text,
  kind       text,
  category   text,
  at         timestamptz,
  actor_name text,
  title      text,
  body       text,
  held       boolean,
  status     text,
  intervention boolean,
  read       boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id::text as item_id, 'message'::text as kind, 'ongoing'::text as category,
         m.created_at as at, p.full_name as actor_name,
         null::text as title, m.body as body,
         null::boolean as held, null::text as status, null::boolean as intervention,
         exists (select 1 from public.message_reads r
                  where r.staff_id = public.current_staff_id() and r.message_id = m.id) as read
    from public.student_messages m
    join public.profiles p on p.id = m.author_staff_id
   where m.student_id = p_student_id
     and public.is_authorized_staff()
     and public.can_user_read_message(public.current_staff_id(), m.id)
  union all
  select r.id::text as item_id,
         'report'::text as kind,
         case r.context when 'master' then 'project' else 'ongoing' end as category,
         r.meeting_at as at, p.full_name as actor_name,
         case r.context when 'master' then 'דיווח מאסטר' else 'דיווח מנטור' end as title,
         case when r.held then coalesce(r.next_steps, '') else 'לא התקיימה: ' || coalesce(r.not_held_reason, '') end as body,
         r.held as held, r.status as status, r.intervention as intervention,
         true as read
    from public.meeting_reports r
    join public.profiles p on p.id = r.staff_id
   where r.student_id = p_student_id
     and r.deleted_at is null
     and public.can_view_student_reports(public.current_staff_id(), p_student_id)
   order by at desc
   limit 200;
$$;

-- ---------------------------------------------------------------------------
-- dashboard_rows v3: archived/deleted excluded, mentor vs master separation,
-- canonical status ordered by meeting_at
-- ---------------------------------------------------------------------------
drop function if exists public.dashboard_rows();
create or replace function public.dashboard_rows()
returns table (
  student_id           uuid,
  student_name         text,
  group_name           text,
  has_project          boolean,
  project_major_name   text,
  intent_text          text,
  primary_master_name  text,
  master_names         text,
  status               text,
  status_source        text,
  last_report_at       timestamptz,
  intervention         boolean,
  mentor_last_meeting_at timestamptz,
  mentor_last_status   text,
  master_last_meeting_at timestamptz,
  master_last_status   text,
  mentor_next_meeting_at timestamptz,
  mentor_next_meeting_weekday smallint,
  mentor_next_meeting_time time,
  master_next_meeting_at timestamptz,
  master_next_meeting_weekday smallint,
  master_next_meeting_time time,
  in_my_groups         boolean,
  master_assigned      boolean,
  in_my_majors         boolean,
  broad_viewer         boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select public.current_staff_id() as sid,
           (public.staff_is_privileged(public.current_staff_id())
            or public.staff_has_role(public.current_staff_id(), 'super_admin')) as broad
  ),
  scope as (
    select s.id
      from public.students s, me
     where not s.is_archived
       and (
         me.broad
         or exists (select 1 from public.group_mentors gm
                     where gm.staff_id = me.sid and gm.group_id = s.group_id)
         or exists (select 1 from public.master_assignments ma
                     where ma.staff_id = me.sid and ma.student_id = s.id)
         or exists (select 1 from public.student_projects sp
                     join public.major_heads mh on mh.major_id = sp.major_id
                    where sp.student_id = s.id and mh.staff_id = me.sid)
       )
  ),
  latest_any as (
    select distinct on (r.student_id)
           r.student_id, r.status, r.intervention, r.meeting_at, r.context
      from public.meeting_reports r
     where r.deleted_at is null
     order by r.student_id, r.created_at desc, r.meeting_at desc
  ),
  latest_mentor as (
    select distinct on (r.student_id)
           r.student_id, r.meeting_at, r.status, r.intervention
      from public.meeting_reports r
     where r.deleted_at is null and r.context = 'mentor'
     order by r.student_id, r.created_at desc, r.meeting_at desc
  ),
  latest_master as (
    select distinct on (r.student_id)
           r.student_id, r.meeting_at, r.status, r.intervention
      from public.meeting_reports r
     where r.deleted_at is null and r.context = 'master'
     order by r.student_id, r.created_at desc, r.meeting_at desc
  ),
  next_meetings as (
    select s2.student_id, s2.context, min(o.due_at) as next_at
      from public.meeting_occurrences o
      join public.meeting_schedules s2 on s2.id = o.schedule_id
     where s2.is_active
       and o.due_at >= now() - interval '30 minutes'
     group by s2.student_id, s2.context
  ),
  next_detail as (
    select distinct on (s2.student_id, s2.context)
           s2.student_id, s2.context, o.due_at, s2.weekday, s2.meeting_time
      from public.meeting_occurrences o
      join public.meeting_schedules s2 on s2.id = o.schedule_id
     where s2.is_active
       and o.due_at >= now() - interval '30 minutes'
     order by s2.student_id, s2.context, o.due_at asc
  )
  select s.id,
         s.first_name || ' ' || s.last_name,
         g.name,
         (sp.id is not null),
         m.name,
         sp.intent_text,
         (select p2.full_name
            from public.master_assignments ma
            join public.profiles p2 on p2.id = ma.staff_id
           where ma.student_id = s.id and ma.is_primary),
         (select string_agg(p2.full_name, ', ' order by p2.full_name)
            from public.master_assignments ma
            join public.profiles p2 on p2.id = ma.staff_id
           where ma.student_id = s.id),
         la.status,
         la.context,
         la.meeting_at,
         la.intervention,
         lm.meeting_at,
         lm.status,
         lmas.meeting_at,
         lmas.status,
         nmn.next_at,
         nmn2.weekday,
         nmn2.meeting_time,
         nms.next_at,
         nms2.weekday,
         nms2.meeting_time,
         (me.broad or exists (
            select 1 from public.group_mentors gm
             where gm.staff_id = me.sid and gm.group_id = s.group_id)),
         (me.broad or exists (
            select 1 from public.master_assignments ma
             where ma.staff_id = me.sid and ma.student_id = s.id)),
         (me.broad or public.is_major_head_for_student(me.sid, s.id)),
         me.broad
    from public.students s
    join scope on scope.id = s.id
    cross join me
    left join public.greenhouse_groups g on g.id = s.group_id
    left join public.student_projects sp on sp.student_id = s.id
    left join public.majors m on m.id = sp.major_id
    left join latest_any la on la.student_id = s.id
    left join latest_mentor lm on lm.student_id = s.id
    left join latest_master lmas on lmas.student_id = s.id
    left join (select student_id, context, next_at from next_meetings where context = 'mentor') nmn
      on nmn.student_id = s.id
    left join (select student_id, context, next_at from next_meetings where context = 'master') nms
      on nms.student_id = s.id
    left join next_detail nmn2 on nmn2.student_id = s.id and nmn2.context = 'mentor'
    left join next_detail nms2 on nms2.student_id = s.id and nms2.context = 'master'
   order by
     case la.status when 'red' then 0 when 'yellow' then 1 when 'green' then 2 else 3 end,
     s.first_name, s.last_name;
$$;

-- ---------------------------------------------------------------------------
-- intake windows: archive soft state
-- ---------------------------------------------------------------------------
alter table public.intake_windows add column if not exists archived_at timestamptz;
