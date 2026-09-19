-- ============================================================================
-- Migration 20260916000002: WEEKLY MEETINGS + CONVERSATIONAL MEETING REPORTS
--
-- Part B of the projects+meetings phase.
--
-- * meeting_schedules  — recurring weekly schedule (student × staff ×
--                        mentor|master, weekday 0=Sunday..6=Saturday, time,
--                        Asia/Jerusalem). Overlapping meetings at the same
--                        time are EXPLICITLY allowed (no uniqueness rule).
-- * meeting_occurrences— one row per schedule per school week (unique
--                        schedule_id + week_start). week_start is Sunday
--                        (Asia/Jerusalem). notified_at deduplicates pushes;
--                        a same-week reschedule moves due_at (never the
--                        schedule) and re-arms the notification.
-- * meeting_reports    — one report per occurrence; held/not-held, reason,
--                        optional same-week reschedule, green/yellow/red
--                        status, intervention categories + details, next
--                        steps.
-- * canonical current student status = latest meeting report (by created_at);
--   a student with no report has NULL status → UI shows "טרם דווח".
-- ============================================================================

create table public.meeting_schedules (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  staff_id   uuid not null references public.profiles (id) on delete cascade,
  context    text not null check (context in ('mentor', 'master')),
  weekday    smallint not null check (weekday between 0 and 6), -- 0=Sunday
  meeting_time time not null,
  timezone   text not null default 'Asia/Jerusalem',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_meeting_schedules_student on public.meeting_schedules (student_id);
create index idx_meeting_schedules_staff   on public.meeting_schedules (staff_id);

create table public.meeting_occurrences (
  id          uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.meeting_schedules (id) on delete cascade,
  due_at      timestamptz not null, -- absolute instant (Asia/Jerusalem wall time)
  week_start  date not null,        -- Sunday opening the school week (Asia/Jerusalem)
  notified_at timestamptz,          -- reminder deduplication
  created_at  timestamptz not null default now(),
  unique (schedule_id, week_start)  -- one occurrence per schedule per school week
);

create index idx_meeting_occurrences_due on public.meeting_occurrences (due_at)
  where notified_at is null;
create index idx_meeting_occurrences_schedule on public.meeting_occurrences (schedule_id);

create table public.meeting_reports (
  id                       uuid primary key default gen_random_uuid(),
  occurrence_id            uuid not null unique references public.meeting_occurrences (id) on delete cascade,
  schedule_id              uuid not null references public.meeting_schedules (id) on delete cascade,
  staff_id                 uuid not null references public.profiles (id),
  student_id               uuid not null references public.students (id) on delete cascade,
  held                     boolean not null,
  not_held_reason          text,
  rescheduled_to           timestamptz,
  status                   text not null check (status in ('green', 'yellow', 'red')),
  intervention             boolean not null,
  intervention_categories  text[] not null default '{}',
  intervention_functional  text,
  intervention_emotional   text,
  intervention_other       text,
  next_steps               text,
  created_at               timestamptz not null default clock_timestamp(),
  updated_at               timestamptz not null default now(),
  constraint meeting_report_not_held_reason check (
    held = true or (not_held_reason is not null and length(btrim(not_held_reason)) > 0)
  ),
  constraint meeting_report_held_next_steps check (
    held = false or (next_steps is not null and length(btrim(next_steps)) > 0)
  ),
  constraint meeting_report_categories_valid check (
    intervention_categories <@ array['functional', 'emotional', 'other']::text[]
  ),
  constraint meeting_report_categories_need_intervention check (
    intervention = false or intervention_categories <> '{}'
  )
);

create index idx_meeting_reports_student on public.meeting_reports (student_id, created_at desc);
create index idx_meeting_reports_staff   on public.meeting_reports (staff_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['meeting_schedules','meeting_reports']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- report visibility: reporters, staff related to the student, privileged
-- ---------------------------------------------------------------------------
create or replace function public.can_view_student_reports(
  p_staff_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_is_authorized(p_staff_id)
     and (
       public.staff_is_privileged(p_staff_id)
       or public.staff_has_role(p_staff_id, 'super_admin')
       or public.is_student_mentor(p_staff_id, p_student_id)
       or public.is_assigned_master(p_staff_id, p_student_id)
       or public.is_major_head_for_student(p_staff_id, p_student_id)
     );
$$;

-- ---------------------------------------------------------------------------
-- Scheduler support: ensure one occurrence per active schedule for a given
-- school week. Slots more than an hour in the past are not generated
-- (prevents stale reminders for schedules created late in the week).
-- Callable by service_role only (the cron route).
-- ---------------------------------------------------------------------------
create or replace function public.scheduler_generate_occurrences(p_week_start date)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.meeting_occurrences (schedule_id, due_at, week_start)
  select s.id,
         ((p_week_start + s.weekday)::date + s.meeting_time) at time zone 'Asia/Jerusalem',
         p_week_start
    from public.meeting_schedules s
   where s.is_active
     and ((p_week_start + s.weekday)::date + s.meeting_time) at time zone 'Asia/Jerusalem'
         > now() - interval '1 hour'
  on conflict (schedule_id, week_start) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedule management (mentor / master / super_admin)
-- ---------------------------------------------------------------------------
create or replace function public.upsert_meeting_schedule(
  p_student_id uuid,
  p_context text,
  p_weekday smallint,
  p_meeting_time time,
  p_is_active boolean,
  p_schedule_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_id uuid;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_context not in ('mentor', 'master') then
    raise exception 'Invalid meeting context' using errcode = '23514';
  end if;
  if p_weekday is null or p_weekday < 0 or p_weekday > 6 then
    raise exception 'Invalid weekday' using errcode = '23514';
  end if;
  if not exists (select 1 from public.students s where s.id = p_student_id and not s.is_archived) then
    raise exception 'Student not found' using errcode = '23514';
  end if;

  if p_schedule_id is null then
    -- create: mentor must mentor the student's group; master must be assigned
    if not (
      (p_context = 'mentor' and public.is_student_mentor(v_staff, p_student_id))
      or (p_context = 'master' and public.is_assigned_master(v_staff, p_student_id))
      or public.staff_has_role(v_staff, 'super_admin')
    ) then
      raise exception 'Not authorized to schedule meetings for this student'
        using errcode = '42501';
    end if;

    insert into public.meeting_schedules (student_id, staff_id, context, weekday, meeting_time, is_active)
    values (p_student_id, v_staff, p_context, p_weekday, p_meeting_time, p_is_active)
    returning id into v_id;

    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'meeting_schedule_create', 'meeting_schedule', v_id,
            jsonb_build_object('student_id', p_student_id, 'context', p_context,
                               'weekday', p_weekday, 'meeting_time', p_meeting_time));
  else
    -- edit: only the schedule owner (or super_admin)
    select id into v_id
      from public.meeting_schedules
     where id = p_schedule_id
       and (staff_id = v_staff or public.staff_has_role(v_staff, 'super_admin'));
    if v_id is null then
      raise exception 'Schedule not found or not yours' using errcode = '42501';
    end if;

    update public.meeting_schedules
       set weekday = p_weekday, meeting_time = p_meeting_time, is_active = p_is_active
     where id = v_id;

    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'meeting_schedule_update', 'meeting_schedule', v_id,
            jsonb_build_object('student_id', p_student_id, 'weekday', p_weekday,
                               'meeting_time', p_meeting_time, 'is_active', p_is_active));
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reportable occurrences for the current staff member on a student:
-- unreported occurrences of THEIR schedules, already due (or imminent).
-- ---------------------------------------------------------------------------
create or replace function public.my_reportable_occurrences(p_student_id uuid)
returns table (
  occurrence_id uuid,
  schedule_id   uuid,
  due_at        timestamptz,
  context       text,
  weekday       smallint,
  meeting_time  time
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, s.id, o.due_at, s.context, s.weekday, s.meeting_time
    from public.meeting_occurrences o
    join public.meeting_schedules s on s.id = o.schedule_id
   where s.staff_id = public.current_staff_id()
     and s.student_id = p_student_id
     and o.due_at <= now() + interval '15 minutes'
     and not exists (
       select 1 from public.meeting_reports r where r.occurrence_id = o.id
     )
   order by o.due_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Submit a meeting report (reporter = schedule owner). Validates everything
-- server-side, including same-school-week rescheduling (Sunday–Saturday,
-- Asia/Jerusalem). Rescheduling moves the OCCURRENCE only — the recurring
-- schedule keeps its weekday/time.
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

  -- optional same-school-week reschedule (only for a not-held meeting)
  if not p_held and p_reschedule_to is not null then
    -- Sunday opening the week of the proposed instant, in Asia/Jerusalem
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
           notified_at = null -- re-arm the reminder for the new time
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
-- Canonical status + dashboards
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_rows()
returns table (
  student_id           uuid,
  student_name         text,
  group_name           text,
  has_project          boolean,
  project_major_name   text,
  intent_text          text,
  master_names         text,
  status               text,
  last_report_at       timestamptz,
  intervention         boolean,
  next_meeting_at      timestamptz,
  next_meeting_weekday smallint,
  next_meeting_time    time,
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
  latest_report as (
    select distinct on (r.student_id)
           r.student_id, r.status, r.created_at, r.intervention
      from public.meeting_reports r
     order by r.student_id, r.created_at desc
  ),
  next_meeting as (
    select distinct on (s2.student_id)
           s2.student_id, o.due_at, s2.weekday, s2.meeting_time
      from public.meeting_occurrences o
      join public.meeting_schedules s2 on s2.id = o.schedule_id
     where s2.is_active
       and o.due_at >= now() - interval '30 minutes'
     order by s2.student_id, o.due_at asc
  )
  select s.id,
         s.first_name || ' ' || s.last_name,
         g.name,
         (sp.id is not null),
         m.name,
         sp.intent_text,
         (select string_agg(p2.full_name, ', ' order by p2.full_name)
            from public.master_assignments ma
            join public.profiles p2 on p2.id = ma.staff_id
           where ma.student_id = s.id),
         lr.status,
         lr.created_at,
         lr.intervention,
         nm.due_at,
         nm.weekday,
         nm.meeting_time,
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
    left join latest_report lr on lr.student_id = s.id
    left join next_meeting nm on nm.student_id = s.id
   order by
     case lr.status when 'red' then 0 when 'yellow' then 1 when 'green' then 2 else 3 end,
     s.first_name, s.last_name;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.meeting_schedules   enable row level security;
alter table public.meeting_occurrences enable row level security;
alter table public.meeting_reports     enable row level security;

-- schedules/occurrences are staff-visible operational info; writes via RPC only
create policy "meeting_schedules_select_staff"
  on public.meeting_schedules
  for select to authenticated
  using (public.is_authorized_staff());

create policy "meeting_occurrences_select_staff"
  on public.meeting_occurrences
  for select to authenticated
  using (public.is_authorized_staff());

-- reports: reporter + staff related to the student + privileged
create policy "meeting_reports_select_related"
  on public.meeting_reports
  for select to authenticated
  using (public.can_view_student_reports(public.current_staff_id(), student_id));

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
grant select on public.meeting_schedules   to authenticated;
grant select on public.meeting_occurrences to authenticated;
grant select on public.meeting_reports     to authenticated;
grant all on public.meeting_schedules      to service_role;
grant all on public.meeting_occurrences    to service_role;
grant all on public.meeting_reports        to service_role;

revoke all on function public.can_view_student_reports(uuid, uuid)        from public, anon;
revoke all on function public.scheduler_generate_occurrences(date)        from public, anon, authenticated;
revoke all on function public.upsert_meeting_schedule(uuid, text, smallint, time, boolean, uuid) from public, anon, authenticated;
revoke all on function public.my_reportable_occurrences(uuid)             from public, anon, authenticated;
revoke all on function public.submit_meeting_report(uuid, boolean, text, timestamptz, text, boolean, text[], text, text, text, text) from public, anon, authenticated;
revoke all on function public.dashboard_rows()                            from public, anon;

grant execute on function public.can_view_student_reports(uuid, uuid)     to authenticated, service_role;
grant execute on function public.scheduler_generate_occurrences(date)     to service_role;
grant execute on function public.upsert_meeting_schedule(uuid, text, smallint, time, boolean, uuid) to authenticated;
grant execute on function public.my_reportable_occurrences(uuid)          to authenticated;
grant execute on function public.submit_meeting_report(uuid, boolean, text, timestamptz, text, boolean, text[], text, text, text, text) to authenticated;
grant execute on function public.dashboard_rows()                         to authenticated;
