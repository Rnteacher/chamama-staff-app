-- ============================================================================
-- Migration 20260922000002: DAILY ATTENDANCE (phase 4 of daily operations)
--
-- TWO clearly-separated attendance contexts (never one ambiguous record):
--   A. SCHOOL DAILY ATTENDANCE — one canonical record per (student, date),
--      normally recorded by home-group mentors.
--   B. LEARNING GROUP ATTENDANCE — per ACTUAL scheduled session. A group may
--      have multiple slots per day, so the occurrence identity is an explicit
--      session row: learning_group + date + scheduled slot snapshot.
--
-- Product model (IMPORTANT):
--   * "working" is NEVER a manually-entered attendance status. It is DERIVED
--     from the canonical employment resolver
--     (public.is_student_expected_at_work, migration 20260922000001).
--   * planned late arrival / early departure are PLANS (student_day_plans),
--     deliberately separate from actual attendance.
--   * an explicit actual attendance report OVERRIDES the expected-work state
--     (employment data itself is never modified by attendance).
--
-- Tables:
--   school_attendance                 — actual daily status (present/absent/late)
--   student_day_plans                 — planned deviations (late arrival /
--                                       early departure + reason), one row
--                                       per (student, date)
--   learning_group_sessions           — explicit LG occurrence identity
--                                       (group + date + slot snapshot)
--   learning_group_attendance         — actual LG status per (session, student)
--   learning_group_attendance_alerts  — IDEMPOTENT alert linkage:
--                                       unique(session, student, alert_type)
--   student_feed_events               — unified student feed events with a
--                                       deterministic event_key (idempotent
--                                       feed updates)
--
-- Canonical resolver: student_effective_school_status(student, date) — the
-- ONE precedence function (explicit attendance > expected-at-work >
-- unresolved, plus plan context). UI components MUST NOT re-derive this.
--
-- School-absence propagation to LG context is COMPUTED at read time from the
-- resolver — school status is never copied into LG attendance rows, so it can
-- never go stale.
--
-- Permissions (security-definer RPCs; authorization + audit inside):
--   * school attendance + day plans: home-group mentor of the student OR
--     leadership OR super_admin. Employment coordinator does NOT gain
--     attendance-write permissions merely due to the employment role.
--   * LG attendance: staff leader of THAT learning group OR leadership OR
--     super_admin. Student leaders receive NO app permissions.
--   * clients have SELECT-only grants; View-As mutations are blocked in the
--     app layer (assertNotViewAs) before any RPC is invoked.
--
-- Audit: school_attendance_created / school_attendance_updated /
--   school_attendance_override_work / student_day_plan_created / updated /
--   deleted / learning_group_attendance_created / updated.
--   Metadata contains ids/timestamps only — never the plan reason free text.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- school_attendance — ONE canonical current record per student/date.
-- Repeated editing UPDATES this row; it never creates duplicates.
-- History/audit lives in audit_logs (not in duplicate rows).
-- ---------------------------------------------------------------------------
create table public.school_attendance (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.students (id) on delete cascade,
  attendance_date     date not null,
  status              text not null check (status in ('present', 'absent', 'late')),
  -- required exactly when status='late' (Asia/Jerusalem wall clock)
  arrival_time        time,
  recorded_by_staff_id uuid not null references public.profiles (id),
  recorded_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint school_attendance_late_requires_arrival check (
    (status = 'late' and arrival_time is not null)
    or (status <> 'late' and arrival_time is null)
  )
);

-- one canonical record per student/date
create unique index idx_school_attendance_student_date
  on public.school_attendance (student_id, attendance_date);
create index idx_school_attendance_date on public.school_attendance (attendance_date);

comment on table public.school_attendance is
  'ACTUAL daily school attendance. One canonical row per (student, date). '
  'statuses: present | absent | late (late requires arrival_time). '
  '"working" is derived from employment and is intentionally NOT a status here.';

-- ---------------------------------------------------------------------------
-- student_day_plans — PLANNED deviations (never actual attendance).
--   "הגעה מתוכננת 10:30 — בדיקת רופא" / "יציאה מתוכננת 13:00 — טיפול"
-- ---------------------------------------------------------------------------
create table public.student_day_plans (
  id                          uuid primary key default gen_random_uuid(),
  student_id                  uuid not null references public.students (id) on delete cascade,
  plan_date                   date not null,
  planned_late_arrival_time   time,
  planned_early_departure_time time,
  reason                      text check (reason is null or length(btrim(reason)) <= 300),
  created_by_staff_id         uuid not null references public.profiles (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint student_day_plan_has_content check (
    planned_late_arrival_time is not null or planned_early_departure_time is not null
  )
);

create unique index idx_student_day_plans_student_date
  on public.student_day_plans (student_id, plan_date);
create index idx_student_day_plans_date on public.student_day_plans (plan_date);

comment on table public.student_day_plans is
  'PLANNED day exceptions (late arrival / early departure + optional reason). '
  'Deliberately separate from actual attendance; never creates attendance rows.';

-- ---------------------------------------------------------------------------
-- learning_group_sessions — explicit occurrence identity for LG attendance:
-- learning_group + date + scheduled slot. start/end times are a SNAPSHOT of
-- the slot identity so past sessions survive future slot edits (slot_id is
-- best-effort reference, nulled when the slot is redefined).
-- ---------------------------------------------------------------------------
create table public.learning_group_sessions (
  id                uuid primary key default gen_random_uuid(),
  learning_group_id uuid not null references public.learning_groups (id) on delete cascade,
  slot_id           uuid references public.learning_group_weekly_slots (id) on delete set null,
  session_date      date not null,
  start_time        time not null,
  end_time          time not null,
  created_at        timestamptz not null default now(),
  constraint learning_group_session_times_valid check (end_time > start_time),
  -- one session per group/date/slot-identity (a group may hold multiple
  -- distinct slots on the same day — they remain separate sessions)
  unique (learning_group_id, session_date, start_time, end_time)
);

create index idx_lg_sessions_group_date on public.learning_group_sessions (learning_group_id, session_date);
create index idx_lg_sessions_slot       on public.learning_group_sessions (slot_id);

comment on table public.learning_group_sessions is
  'Explicit occurrence identity for Learning Group attendance: group + date + '
  'scheduled slot snapshot. Never key attendance by group+date alone.';

-- ---------------------------------------------------------------------------
-- learning_group_attendance — actual LG status per (session, student).
-- ---------------------------------------------------------------------------
create table public.learning_group_attendance (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.learning_group_sessions (id) on delete cascade,
  student_id          uuid not null references public.students (id) on delete cascade,
  status              text not null check (status in ('present', 'absent', 'late')),
  arrival_time        time,
  recorded_by_staff_id uuid not null references public.profiles (id),
  recorded_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint lg_attendance_late_requires_arrival check (
    (status = 'late' and arrival_time is not null)
    or (status <> 'late' and arrival_time is null)
  ),
  unique (session_id, student_id)
);

create index idx_lg_attendance_student on public.learning_group_attendance (student_id);
create index idx_lg_attendance_session on public.learning_group_attendance (session_id);

-- ---------------------------------------------------------------------------
-- learning_group_attendance_alerts — IDEMPOTENT side-effect linkage.
-- One row per (session, student, alert_type). A feed event / mentor push may
-- only be (re)emitted when the row transitions to is_current = true, so
-- repeated save/reload/edit can never create duplicates.
-- ---------------------------------------------------------------------------
create table public.learning_group_attendance_alerts (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.learning_group_sessions (id) on delete cascade,
  student_id   uuid not null references public.students (id) on delete cascade,
  alert_type   text not null check (alert_type in ('absent', 'late')),
  arrival_time time,
  is_current   boolean not null default true,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (session_id, student_id, alert_type)
);

create index idx_lg_alerts_student on public.learning_group_attendance_alerts (student_id);

comment on table public.learning_group_attendance_alerts is
  'Idempotent alert linkage for LG absence/late while AT SCHOOL. '
  'unique(session, student, alert_type); pushes/feed events fire only on '
  'transition into is_current.';

-- ---------------------------------------------------------------------------
-- student_feed_events — unified student feed events (LG attendance for now).
-- event_key is the deterministic identity → re-emitting the same logical
-- event upserts instead of duplicating.
-- ---------------------------------------------------------------------------
create table public.student_feed_events (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.students (id) on delete cascade,
  source              text not null,
  event_key           text not null unique,
  title               text not null,
  body                text,
  occurred_at         timestamptz not null default now(),
  created_by_staff_id uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_student_feed_events_student on public.student_feed_events (student_id, occurred_at desc);

comment on table public.student_feed_events is
  'Unified student feed events with deterministic event_key (idempotent '
  'upsert semantics). source example: learning_group_attendance.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance (shared set_updated_at trigger from migration 0001)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'school_attendance',
    'student_day_plans',
    'learning_group_attendance',
    'learning_group_attendance_alerts',
    'student_feed_events'
  ]
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;

-- ============================================================================
-- PERMISSION HELPERS
-- ============================================================================

-- home-group mentor of a SPECIFIC group (group_mentors supports 1+ mentors)
create or replace function public.staff_is_group_mentor(p_staff_id uuid, p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_mentors gm
     where gm.group_id = p_group_id
       and gm.staff_id = p_staff_id
  );
$$;

-- school attendance write: home-group mentor of the STUDENT's group OR
-- leadership OR super_admin (employment_coordinator gains NOTHING here)
create or replace function public.staff_can_record_school_attendance(
  p_staff_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_staff_id is not null and (
    public.staff_has_role(p_staff_id, 'leadership')
    or public.staff_has_role(p_staff_id, 'super_admin')
    or exists (
      select 1
        from public.students s
        join public.group_mentors gm on gm.group_id = s.group_id
       where s.id = p_student_id
         and gm.staff_id = p_staff_id
    )
  );
$$;

create or replace function public.staff_can_record_school_attendance_group(
  p_staff_id uuid,
  p_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_staff_id is not null and (
    public.staff_has_role(p_staff_id, 'leadership')
    or public.staff_has_role(p_staff_id, 'super_admin')
    or public.staff_is_group_mentor(p_staff_id, p_group_id)
  );
$$;

-- LG attendance write: staff leader of THAT group OR leadership OR super_admin
create or replace function public.staff_can_record_lg_attendance(
  p_staff_id uuid,
  p_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_staff_id is not null and (
    public.staff_can_manage_all_learning_groups(p_staff_id)
    or public.staff_leads_learning_group(p_staff_id, p_group_id)
  );
$$;

-- ============================================================================
-- CANONICAL EFFECTIVE STATUS RESOLVER — the ONE server-side precedence
-- function for a student/date. Returns STRUCTURED data (not a label):
--   1. explicit actual attendance (present/absent/late) — also the explicit
--      override of an expected-work day ("החניך/ה הגיע/ה לבית הספר")
--   2. expected-at-work (derived — never manually entered)
--   3. unresolved
--   + planned late-arrival / early-departure context from student_day_plans.
-- Learning Group attendance and every screen MUST consume this — precedence
-- logic must never be duplicated in React components.
-- ============================================================================
create or replace function public.student_effective_school_status(
  p_student_id uuid,
  p_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_att public.school_attendance;
  v_work record;
  v_plan public.student_day_plans;
  v_expected boolean := false;
  v_status text;
begin
  select * into v_att
    from public.school_attendance a
   where a.student_id = p_student_id
     and a.attendance_date = p_date;

  select e.expected, e.workplace_name, e.start_time, e.end_time, e.source
    into v_work
    from public.is_student_expected_at_work(p_student_id, p_date) e
   limit 1;
  v_expected := coalesce(v_work.expected, false);

  select * into v_plan
    from public.student_day_plans p
   where p.student_id = p_student_id
     and p.plan_date = p_date;

  v_status :=
    case
      when v_att.id is not null then v_att.status   -- explicit actual report
      when v_expected then 'expected_work'          -- derived from employment
      else 'unresolved'
    end;

  return jsonb_build_object(
    'student_id', p_student_id,
    'date', p_date,
    'status', v_status,
    'recorded', v_att.id is not null,
    'arrival_time', v_att.arrival_time,
    'attendance_id', v_att.id,
    'recorded_by_staff_id', v_att.recorded_by_staff_id,
    'recorded_at', v_att.recorded_at,
    'updated_at', v_att.updated_at,
    'expected_work', v_expected,
    'workplace_name', case when v_expected then v_work.workplace_name end,
    'work_start_time', case when v_expected then v_work.start_time end,
    'work_end_time', case when v_expected then v_work.end_time end,
    -- explicit attendance on an expected-work day = the work override
    'work_overridden', v_att.id is not null and v_expected,
    'planned_late_arrival_time', v_plan.planned_late_arrival_time,
    'planned_early_departure_time', v_plan.planned_early_departure_time,
    'plan_reason', v_plan.reason,
    'plan_id', v_plan.id
  );
end;
$$;

-- ============================================================================
-- READ RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- school attendance roster for ONE home group + date: student rows with the
-- canonical effective status (resolver output), name-ordered. Reopen ordering
-- (absent first) is applied by the UI helper from this structured data.
-- ---------------------------------------------------------------------------
create or replace function public.school_attendance_roster(
  p_group_id uuid,
  p_date date
)
returns table (
  student_id uuid,
  first_name text,
  last_name  text,
  effective  jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.first_name, s.last_name,
         public.student_effective_school_status(s.id, p_date)
    from public.students s
   where s.group_id = p_group_id
     and not s.is_archived
   order by s.first_name, s.last_name;
$$;

-- ---------------------------------------------------------------------------
-- completion counts for one group/date — expected-work students count as
-- resolved even without an attendance row.
-- ---------------------------------------------------------------------------
create or replace function public.school_attendance_counts(
  p_group_id uuid,
  p_date date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with roster as (
    select public.student_effective_school_status(s.id, p_date) as eff
      from public.students s
     where s.group_id = p_group_id
       and not s.is_archived
  )
  select jsonb_build_object(
    'total',     count(*),
    'present',   count(*) filter (where eff ->> 'status' = 'present'),
    'absent',    count(*) filter (where eff ->> 'status' = 'absent'),
    'late',      count(*) filter (where eff ->> 'status' = 'late'),
    'working',   count(*) filter (where eff ->> 'status' = 'expected_work'),
    'unresolved',count(*) filter (where eff ->> 'status' = 'unresolved'),
    'reported',  count(*) filter (where eff ->> 'recorded' = 'true'),
    'resolved',  count(*) filter (where eff ->> 'recorded' = 'true'
                                     or eff ->> 'status' = 'expected_work')
  ) from roster;
$$;

-- ---------------------------------------------------------------------------
-- leadership school-wide overview for one date: per home-group counts.
-- leadership / super_admin only (operational, today-focused — not analytics).
-- ---------------------------------------------------------------------------
create or replace function public.school_attendance_overview(
  p_date date
)
returns table (
  group_id   uuid,
  group_name text,
  total      int,
  present    int,
  absent     int,
  late       int,
  working    int,
  unresolved int,
  reported   int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.current_staff_id() is null
     or not (public.staff_has_role(public.current_staff_id(), 'leadership')
             or public.staff_has_role(public.current_staff_id(), 'super_admin')) then
    raise exception 'Only leadership or super_admin can view the attendance overview'
      using errcode = '42501';
  end if;

  return query
  with roster as (
    select s.group_id,
           public.student_effective_school_status(s.id, p_date) as eff
      from public.students s
     where not s.is_archived
       and s.group_id is not null
  )
  select g.id, g.name,
         count(r.*)::int,
         count(*) filter (where r.eff ->> 'status' = 'present')::int,
         count(*) filter (where r.eff ->> 'status' = 'absent')::int,
         count(*) filter (where r.eff ->> 'status' = 'late')::int,
         count(*) filter (where r.eff ->> 'status' = 'expected_work')::int,
         count(*) filter (where r.eff ->> 'status' = 'unresolved')::int,
         count(*) filter (where r.eff ->> 'recorded' = 'true')::int
    from public.greenhouse_groups g
    left join roster r on r.group_id = g.id
   group by g.id, g.name
   order by g.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- LG attendance for one group/date: every scheduled slot of that weekday as a
-- session entry (session row created lazily on first save), each with the
-- roster (active membership) + recorded attendance + SCHOOL CONTEXT resolved
-- from the canonical resolver (school absence / expected work propagate
-- automatically and are never copied into LG rows).
-- ---------------------------------------------------------------------------
create or replace function public.learning_group_attendance_for_date(
  p_group_id uuid,
  p_date date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(session_obj order by session_obj ->> 'start_time'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'session_id', sess.id,
               'slot_id',    sl.id,
               'start_time', to_char(sl.start_time, 'HH24:MI'),
               'end_time',   to_char(sl.end_time, 'HH24:MI'),
               'roster', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'student_id', st.id,
                          'first_name', st.first_name,
                          'last_name',  st.last_name,
                          'status',     att_l.lg_status,
                          'arrival_time', case when att_l.lg_status = 'late' then att_l.lg_arrival end,
                          'school_status', school_l.school ->> 'status',
                          'school_context', ctx_l.ctx
                        ) order by st.first_name, st.last_name)
                   from public.learning_group_memberships m
                   join public.students st on st.id = m.student_id
                   cross join lateral (
                     select public.student_effective_school_status(st.id, p_date) as school
                   ) school_l
                   cross join lateral (
                     select case
                              when school_l.school ->> 'status' = 'absent'
                                then 'absent_from_school'
                              when school_l.school ->> 'expected_work' = 'true'
                               and school_l.school ->> 'recorded' = 'false'
                                then 'expected_work'
                              else null
                            end as ctx
                   ) ctx_l
                   left join lateral (
                     select la.status as lg_status, la.arrival_time as lg_arrival
                       from public.learning_group_attendance la
                      where la.session_id = sess.id
                        and la.student_id = st.id
                      limit 1
                   ) att_l on true
                  where m.learning_group_id = p_group_id
                    and m.ended_at is null
                    and not st.is_archived
               ), '[]'::jsonb)
             ) as session_obj
        from public.learning_group_weekly_slots sl
        left join public.learning_group_sessions sess
               on sess.learning_group_id = sl.learning_group_id
              and sess.session_date = p_date
              and sess.start_time = sl.start_time
              and sess.end_time = sl.end_time
       where sl.learning_group_id = p_group_id
         and sl.weekday = extract(dow from p_date)::smallint
    ) sessions;
$$;

-- ============================================================================
-- WRITE RPCs (security definer; authorization + validation + audit inside)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- mark ACTUAL school attendance for one student/date (upsert — repeated
-- editing updates the SAME row; never duplicates). Late requires an arrival
-- time (Asia/Jerusalem); non-late clears any arrival time.
-- An explicit report on an expected-work day is the work override — audited
-- separately; employment data itself is NEVER modified.
-- ---------------------------------------------------------------------------
create or replace function public.school_attendance_mark(
  p_student_id uuid,
  p_date date,
  p_status text,
  p_arrival_time time
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff  uuid := public.current_staff_id();
  v_id     uuid;
  v_existing uuid;
  v_created boolean := false;
  v_expected boolean := false;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_record_school_attendance(v_staff, p_student_id) then
    raise exception 'Only a mentor of this student''s home group, leadership or super_admin can record school attendance'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.students s where s.id = p_student_id and not s.is_archived) then
    raise exception 'החניך/ה לא נמצא/ת' using errcode = '23514';
  end if;
  if p_date is null then
    raise exception 'תאריך נדרש' using errcode = '23514';
  end if;
  if p_date > (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'לא ניתן לדווח נוכחות לתאריך עתידי' using errcode = '23514';
  end if;
  if p_status not in ('present', 'absent', 'late') then
    raise exception 'סטטוס נוכחות לא תקין' using errcode = '23514';
  end if;
  if p_status = 'late' and p_arrival_time is null then
    raise exception 'שעת הגעה נדרשת כאשר הסטטוס הוא איחור' using errcode = '23514';
  end if;

  select e.expected into v_expected
    from public.is_student_expected_at_work(p_student_id, p_date) e
   limit 1;
  v_expected := coalesce(v_expected, false);

  select a.id into v_existing
    from public.school_attendance a
   where a.student_id = p_student_id
     and a.attendance_date = p_date;

  insert into public.school_attendance
    (student_id, attendance_date, status, arrival_time, recorded_by_staff_id)
  values
    (p_student_id, p_date, p_status,
     case when p_status = 'late' then p_arrival_time end,
     v_staff)
  on conflict (student_id, attendance_date) do update
    set status              = excluded.status,
        arrival_time        = excluded.arrival_time,
        recorded_by_staff_id = excluded.recorded_by_staff_id,
        recorded_at         = now();

  select a.id into v_id
    from public.school_attendance a
   where a.student_id = p_student_id
     and a.attendance_date = p_date;
  v_created := v_existing is null;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff,
          case when v_created then 'school_attendance_created' else 'school_attendance_updated' end,
          'school_attendance', v_id,
          jsonb_build_object('student_id', p_student_id, 'date', p_date, 'status', p_status));

  -- explicit attendance overrides an expected-work day (audited once per save)
  if v_expected then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'school_attendance_override_work', 'school_attendance', v_id,
            jsonb_build_object('student_id', p_student_id, 'date', p_date, 'status', p_status));
  end if;

  return jsonb_build_object('id', v_id, 'created', v_created, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- clear a school attendance record (reset to unresolved / derived work state)
-- ---------------------------------------------------------------------------
create or replace function public.school_attendance_clear(
  p_student_id uuid,
  p_date date
)
returns boolean
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
  if not public.staff_can_record_school_attendance(v_staff, p_student_id) then
    raise exception 'Only a mentor of this student''s home group, leadership or super_admin can record school attendance'
      using errcode = '42501';
  end if;

  select a.id into v_id
    from public.school_attendance a
   where a.student_id = p_student_id
     and a.attendance_date = p_date;
  if v_id is null then
    return true; -- nothing to clear — idempotent
  end if;

  delete from public.school_attendance where id = v_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'school_attendance_updated', 'school_attendance', v_id,
          jsonb_build_object('student_id', p_student_id, 'date', p_date, 'cleared', true));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- BULK "סמן את כל מי שלא סומן כנוכח" — SAFE by construction:
-- marks present ONLY students who are currently unresolved (no record) AND
-- not expected at work AND without a planned late arrival for that date.
-- Explicit absent/late records and expected-work states are never overwritten.
-- Returns the number of students marked.
-- ---------------------------------------------------------------------------
create or replace function public.school_attendance_bulk_mark_present(
  p_group_id uuid,
  p_date date
)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_marked int := 0;
  v_sid uuid;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_record_school_attendance_group(v_staff, p_group_id) then
    raise exception 'Only a mentor of this group, leadership or super_admin can record school attendance'
      using errcode = '42501';
  end if;
  if p_date is null or p_date > (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'תאריך לא תקין' using errcode = '23514';
  end if;

  for v_sid in
    select s.id
      from public.students s
     where s.group_id = p_group_id
       and not s.is_archived
       and not exists (
         select 1 from public.school_attendance a
          where a.student_id = s.id and a.attendance_date = p_date)
       and not coalesce((
         select e.expected
           from public.is_student_expected_at_work(s.id, p_date) e limit 1), false)
       and not exists (
         select 1 from public.student_day_plans pl
          where pl.student_id = s.id and pl.plan_date = p_date
            and pl.planned_late_arrival_time is not null)
  loop
    insert into public.school_attendance
      (student_id, attendance_date, status, recorded_by_staff_id)
    values (v_sid, p_date, 'present', v_staff)
    on conflict (student_id, attendance_date) do nothing;
    v_marked := v_marked + 1;
  end loop;

  if v_marked > 0 then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'school_attendance_updated', 'greenhouse_group', p_group_id,
            jsonb_build_object('bulk_present', true, 'date', p_date, 'marked', v_marked));
  end if;
  return v_marked;
end;
$$;

-- ---------------------------------------------------------------------------
-- PLANNED day exception (late arrival / early departure + reason).
-- One plan row per student/date (upsert). This NEVER creates actual
-- attendance and never classifies anyone as late by itself.
-- Permission: home-group mentor of the student OR leadership OR super_admin.
-- ---------------------------------------------------------------------------
create or replace function public.student_day_plan_upsert(
  p_student_id uuid,
  p_date date,
  p_late_arrival_time time,
  p_early_departure_time time,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_id uuid;
  v_existing uuid;
  v_created boolean := false;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_record_school_attendance(v_staff, p_student_id) then
    raise exception 'Only a mentor of this student''s home group, leadership or super_admin can manage day plans'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.students s where s.id = p_student_id and not s.is_archived) then
    raise exception 'החניך/ה לא נמצא/ת' using errcode = '23514';
  end if;
  if p_date is null then
    raise exception 'תאריך נדרש' using errcode = '23514';
  end if;
  if p_late_arrival_time is null and p_early_departure_time is null then
    raise exception 'נדרשת שעת הגעה או שעת יציאה מתוכננת' using errcode = '23514';
  end if;

  select pl.id into v_existing
    from public.student_day_plans pl
   where pl.student_id = p_student_id and pl.plan_date = p_date;

  insert into public.student_day_plans
    (student_id, plan_date, planned_late_arrival_time, planned_early_departure_time,
     reason, created_by_staff_id)
  values
    (p_student_id, p_date, p_late_arrival_time, p_early_departure_time,
     nullif(btrim(coalesce(p_reason, '')), ''), v_staff)
  on conflict (student_id, plan_date) do update
    set planned_late_arrival_time    = excluded.planned_late_arrival_time,
        planned_early_departure_time = excluded.planned_early_departure_time,
        reason                       = excluded.reason;

  select pl.id into v_id
    from public.student_day_plans pl
   where pl.student_id = p_student_id and pl.plan_date = p_date;
  v_created := v_existing is null;

  -- ids/dates only in metadata — never the free-text reason
  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff,
          case when v_created then 'student_day_plan_created' else 'student_day_plan_updated' end,
          'student_day_plan', v_id,
          jsonb_build_object('student_id', p_student_id, 'date', p_date,
                             'late_arrival', p_late_arrival_time is not null,
                             'early_departure', p_early_departure_time is not null));

  return jsonb_build_object('id', v_id, 'created', v_created);
end;
$$;

create or replace function public.student_day_plan_delete(
  p_student_id uuid,
  p_date date
)
returns boolean
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
  if not public.staff_can_record_school_attendance(v_staff, p_student_id) then
    raise exception 'Only a mentor of this student''s home group, leadership or super_admin can manage day plans'
      using errcode = '42501';
  end if;

  select pl.id into v_id
    from public.student_day_plans pl
   where pl.student_id = p_student_id and pl.plan_date = p_date;
  if v_id is null then
    return true;
  end if;

  delete from public.student_day_plans where id = v_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'student_day_plan_deleted', 'student_day_plan', v_id,
          jsonb_build_object('student_id', p_student_id, 'date', p_date));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- LG attendance save — per ACTUAL scheduled session.
--   1. authorization: staff leader of THAT group OR leadership OR super_admin
--   2. session identity: (group, date, slot times) — created lazily on first
--      save; the times MUST match a real weekly slot (no arbitrary sessions)
--   3. roster integrity: the student must have an ACTIVE membership
--   4. IDEMPOTENT side effects — only when the student is otherwise AT SCHOOL
--      (school attendance not 'absent' AND not expected-at-work):
--        absent/late → alert row transition → ONE feed event (deterministic
--        event_key upsert) + mentor ids returned for ONE push batch
--        present / school-absent / expected-work → resolve current alerts and
--        remove their feed events
--      Repeated saves of the same state create NO duplicates; a late-time edit
--      updates the existing feed event instead of adding a new one.
-- ---------------------------------------------------------------------------
create or replace function public.learning_group_attendance_save(
  p_group_id uuid,
  p_session_date date,
  p_start_time time,
  p_end_time time,
  p_student_id uuid,
  p_status text,
  p_arrival_time time
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff       uuid := public.current_staff_id();
  v_slot_id     uuid;
  v_session_id  uuid;
  v_att_id      uuid;
  v_created     boolean := false;
  v_school      jsonb;
  v_school_st   text;
  v_at_school   boolean;
  v_alert_type  text;
  v_alert_created boolean := false;
  v_alert_was_current boolean;
  v_group_name  text;
  v_title       text;
  v_body        text;
  v_event_key   text;
  v_mentors     uuid[] := '{}';
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_record_lg_attendance(v_staff, p_group_id) then
    raise exception 'Only a staff leader of this learning group, leadership or super_admin can record its attendance'
      using errcode = '42501';
  end if;
  if p_session_date is null
     or p_session_date > (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'תאריך לא תקין' using errcode = '23514';
  end if;
  if p_status not in ('present', 'absent', 'late') then
    raise exception 'סטטוס נוכחות לא תקין' using errcode = '23514';
  end if;
  if p_status = 'late' and p_arrival_time is null then
    raise exception 'שעת הגעה נדרשת כאשר הסטטוס הוא איחור' using errcode = '23514';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'מפגש לא תקין' using errcode = '23514';
  end if;

  select g.name into v_group_name from public.learning_groups g where g.id = p_group_id;
  if v_group_name is null then
    raise exception 'Learning group not found';
  end if;

  -- session identity must match a real weekly slot of this group
  select sl.id into v_slot_id
    from public.learning_group_weekly_slots sl
   where sl.learning_group_id = p_group_id
     and sl.weekday = extract(dow from p_session_date)::smallint
     and sl.start_time = p_start_time
     and sl.end_time = p_end_time
   limit 1;
  if v_slot_id is null and not exists (
    select 1 from public.learning_group_sessions sess
     where sess.learning_group_id = p_group_id
       and sess.session_date = p_session_date
       and sess.start_time = p_start_time
       and sess.end_time = p_end_time
  ) then
    raise exception 'המפגש אינו קיים בלוח השבועי של הקבוצה' using errcode = '23514';
  end if;

  insert into public.learning_group_sessions
    (learning_group_id, slot_id, session_date, start_time, end_time)
  values (p_group_id, v_slot_id, p_session_date, p_start_time, p_end_time)
  on conflict (learning_group_id, session_date, start_time, end_time) do nothing;

  select sess.id into v_session_id
    from public.learning_group_sessions sess
   where sess.learning_group_id = p_group_id
     and sess.session_date = p_session_date
     and sess.start_time = p_start_time
     and sess.end_time = p_end_time;

  -- roster integrity: active membership required
  if not exists (
    select 1 from public.learning_group_memberships m
     where m.learning_group_id = p_group_id
       and m.student_id = p_student_id
       and m.ended_at is null
  ) then
    raise exception 'החניך/ה אינו/אינה חבר/ה פעיל/ה בקבוצה' using errcode = '23514';
  end if;

  -- upsert the attendance row (never duplicates)
  select la.id into v_att_id
    from public.learning_group_attendance la
   where la.session_id = v_session_id and la.student_id = p_student_id;

  insert into public.learning_group_attendance
    (session_id, student_id, status, arrival_time, recorded_by_staff_id)
  values
    (v_session_id, p_student_id, p_status,
     case when p_status = 'late' then p_arrival_time end, v_staff)
  on conflict (session_id, student_id) do update
    set status               = excluded.status,
        arrival_time         = excluded.arrival_time,
        recorded_by_staff_id = excluded.recorded_by_staff_id,
        recorded_at          = now();

  v_created := v_att_id is null;

  select la.id into v_att_id
    from public.learning_group_attendance la
   where la.session_id = v_session_id and la.student_id = p_student_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff,
          case when v_created then 'learning_group_attendance_created'
               else 'learning_group_attendance_updated' end,
          'learning_group_attendance', v_att_id,
          jsonb_build_object('student_id', p_student_id, 'session_id', v_session_id,
                             'group_id', p_group_id, 'status', p_status));

  -- ------------------------------------------------------------- alerts ----
  select * into v_school from public.student_effective_school_status(p_student_id, p_session_date);
  v_school_st := v_school ->> 'status';
  -- at school = explicit present/late record OR still-unresolved default;
  -- school absence and expected-work (without an override) are excluded.
  v_at_school := v_school_st in ('present', 'late', 'unresolved');

  if p_status in ('absent', 'late') and v_at_school then
    v_alert_type := p_status;

    -- transition detection BEFORE the upsert: an alert counts as created only
    -- when it did not exist or was already resolved (is_current = false)
    select a.is_current into v_alert_was_current
      from public.learning_group_attendance_alerts a
     where a.session_id = v_session_id
       and a.student_id = p_student_id
       and a.alert_type = v_alert_type;

    insert into public.learning_group_attendance_alerts
      (session_id, student_id, alert_type, arrival_time, is_current)
    values
      (v_session_id, p_student_id, v_alert_type,
       case when v_alert_type = 'late' then p_arrival_time end, true)
    on conflict (session_id, student_id, alert_type) do update
      set arrival_time = excluded.arrival_time,
          is_current   = true,
          resolved_at  = null;

    v_alert_created := (v_alert_was_current is null or v_alert_was_current = false);

    -- feed event: deterministic key → upsert (late-time edit updates in place)
    v_event_key := 'lg_att:' || v_session_id || ':' || p_student_id || ':' || v_alert_type;
    if v_alert_type = 'absent' then
      v_title := 'נעדר/ה מקבוצת הלמידה ' || v_group_name;
      v_body  := null;
    else
      v_title := 'איחר/ה לקבוצת הלמידה ' || v_group_name;
      v_body  := 'הגיע/ה ב־' || to_char(p_arrival_time, 'HH24:MI');
    end if;

    insert into public.student_feed_events
      (student_id, source, event_key, title, body, occurred_at, created_by_staff_id)
    values
      (p_student_id, 'learning_group_attendance', v_event_key, v_title, v_body, now(), v_staff)
    on conflict (event_key) do update
      set title             = excluded.title,
          body              = excluded.body,
          occurred_at       = excluded.occurred_at,
          created_by_staff_id = excluded.created_by_staff_id;

    -- resolve the OTHER alert type (e.g. absent resolved when turning late)
    update public.learning_group_attendance_alerts a
       set is_current = false, resolved_at = now()
     where a.session_id = v_session_id
       and a.student_id = p_student_id
       and a.alert_type <> v_alert_type
       and a.is_current;
    delete from public.student_feed_events fe
     where fe.student_id = p_student_id
       and fe.event_key in (
         'lg_att:' || v_session_id || ':' || p_student_id || ':absent',
         'lg_att:' || v_session_id || ':' || p_student_id || ':late')
       and fe.event_key <> v_event_key;

    -- mentors of the student's home group — push is sent ONCE per transition
    select coalesce(array_agg(gm.staff_id), '{}') into v_mentors
      from public.students s
      join public.group_mentors gm on gm.group_id = s.group_id
     where s.id = p_student_id;
  else
    -- present / school-absent / expected-work → resolve any current alerts
    update public.learning_group_attendance_alerts a
       set is_current = false, resolved_at = now()
     where a.session_id = v_session_id
       and a.student_id = p_student_id
       and a.is_current;
    delete from public.student_feed_events fe
     where fe.student_id = p_student_id
       and fe.event_key in (
         'lg_att:' || v_session_id || ':' || p_student_id || ':absent',
         'lg_att:' || v_session_id || ':' || p_student_id || ':late');
  end if;

  return jsonb_build_object(
    'id', v_att_id,
    'created', v_created,
    'session_id', v_session_id,
    'alert_created', v_alert_created,
    'alert_type', v_alert_type,
    'at_school', v_at_school,
    'mentor_ids', v_mentors
  );
end;
$$;

-- ============================================================================
-- UNIFIED STUDENT FEED — LG attendance events join the SAME feed (no second
-- feed system). Visibility follows the student-report read rule, keeping feed
-- filters coherent across sources.
-- ============================================================================
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
  read       boolean,
  not_held_reason text,
  intervention_categories text[],
  intervention_functional text,
  intervention_emotional text,
  intervention_other text,
  next_steps text,
  meeting_at timestamptz,
  source_id  uuid,
  author_staff_id uuid
) language sql stable security definer set search_path = public as $$
  select m.id::text, 'message'::text, 'ongoing'::text,
         m.created_at, p.full_name, null::text, m.body,
         null::boolean, null::text, null::boolean,
         exists (select 1 from public.message_reads r
                  where r.staff_id = public.current_staff_id() and r.message_id = m.id),
         null::text, null::text[], null::text, null::text, null::text, null::text,
         null::timestamptz, m.id,
         m.author_staff_id
    from public.student_messages m
    join public.profiles p on p.id = m.author_staff_id
   where m.student_id = p_student_id
     and m.deleted_at is null
     and public.is_authorized_staff()
     and public.can_user_read_message(public.current_staff_id(), m.id)
  union all
  select r.id::text, 'report'::text,
         case r.context when 'master' then 'project' else 'ongoing' end,
         r.meeting_at, p.full_name,
         case r.context when 'master' then 'דיווח מאסטר' else 'דיווח מנטור' end,
         case when r.held then coalesce(r.next_steps, '') else 'לא התקיימה: ' || coalesce(r.not_held_reason, '') end,
         r.held, r.status, r.intervention, true,
         r.not_held_reason, r.intervention_categories,
         r.intervention_functional, r.intervention_emotional,
         r.intervention_other, r.next_steps, r.meeting_at, r.id,
         null::uuid
    from public.meeting_reports r
    join public.profiles p on p.id = r.staff_id
   where r.student_id = p_student_id and r.deleted_at is null
     and public.can_view_student_reports(public.current_staff_id(), p_student_id)
  union all
  select fs.id::text, 'form'::text, d.feed_category::text,
         fs.submitted_at, coalesce(p.full_name, ''),
         'טופס: ' || d.name, null::text,
         null::boolean, null::text, null::boolean, true,
         null::text, null::text[], null::text, null::text, null::text, null::text,
         null::timestamptz, fs.id,
         null::uuid
    from public.form_submissions fs
    join public.form_definitions d on d.id = fs.form_definition_id
    left join public.profiles p on p.id = fs.respondent_staff_id
   where fs.subject_student_id = p_student_id and fs.deleted_at is null
     and d.feed_category <> 'hidden'
     and public.is_authorized_staff()
     and (fs.respondent_staff_id = public.current_staff_id()
          or public.can_view_student_reports(public.current_staff_id(), p_student_id))
  union all
  -- learning-group attendance exceptions (idempotent deterministic events)
  select e.id::text, 'attendance'::text, e.source::text,
         e.occurred_at, coalesce(p.full_name, ''),
         e.title, e.body,
         null::boolean, null::text, null::boolean, true,
         null::text, null::text[], null::text, null::text, null::text, null::text,
         null::timestamptz, e.id,
         e.created_by_staff_id
    from public.student_feed_events e
    left join public.profiles p on p.id = e.created_by_staff_id
   where e.student_id = p_student_id
     and public.can_view_student_reports(public.current_staff_id(), p_student_id)
   order by 4 desc limit 200;
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.school_attendance                 enable row level security;
alter table public.student_day_plans                 enable row level security;
alter table public.learning_group_sessions           enable row level security;
alter table public.learning_group_attendance         enable row level security;
alter table public.learning_group_attendance_alerts  enable row level security;
alter table public.student_feed_events               enable row level security;

-- read model: any authorized staff; NO client write policies — every mutation
-- runs exclusively through the security-definer RPCs above (authorization +
-- audit inside). View-As stays read-only in the app layer.
create policy "school_attendance_select_staff" on public.school_attendance
  for select to authenticated using (public.is_authorized_staff());

create policy "student_day_plans_select_staff" on public.student_day_plans
  for select to authenticated using (public.is_authorized_staff());

create policy "lg_sessions_select_staff" on public.learning_group_sessions
  for select to authenticated using (public.is_authorized_staff());

create policy "lg_attendance_select_staff" on public.learning_group_attendance
  for select to authenticated using (public.is_authorized_staff());

create policy "lg_attendance_alerts_select_staff" on public.learning_group_attendance_alerts
  for select to authenticated using (public.is_authorized_staff());

create policy "student_feed_events_select_staff" on public.student_feed_events
  for select to authenticated using (public.is_authorized_staff());

-- ============================================================================
-- Grants
-- ============================================================================
grant select on
  public.school_attendance,
  public.student_day_plans,
  public.learning_group_sessions,
  public.learning_group_attendance,
  public.learning_group_attendance_alerts,
  public.student_feed_events
  to authenticated;

grant all on
  public.school_attendance,
  public.student_day_plans,
  public.learning_group_sessions,
  public.learning_group_attendance,
  public.learning_group_attendance_alerts,
  public.student_feed_events
  to service_role;

revoke all on function public.staff_is_group_mentor(uuid, uuid)                          from public, anon;
revoke all on function public.staff_can_record_school_attendance(uuid, uuid)             from public, anon;
revoke all on function public.staff_can_record_school_attendance_group(uuid, uuid)       from public, anon;
revoke all on function public.staff_can_record_lg_attendance(uuid, uuid)                 from public, anon;
revoke all on function public.student_effective_school_status(uuid, date)                from public, anon;
revoke all on function public.school_attendance_roster(uuid, date)                       from public, anon;
revoke all on function public.school_attendance_counts(uuid, date)                       from public, anon;
revoke all on function public.school_attendance_overview(date)                           from public, anon;
revoke all on function public.learning_group_attendance_for_date(uuid, date)             from public, anon;
revoke all on function public.school_attendance_mark(uuid, date, text, time)             from public, anon;
revoke all on function public.school_attendance_clear(uuid, date)                        from public, anon;
revoke all on function public.school_attendance_bulk_mark_present(uuid, date)            from public, anon;
revoke all on function public.student_day_plan_upsert(uuid, date, time, time, text)      from public, anon;
revoke all on function public.student_day_plan_delete(uuid, date)                        from public, anon;
revoke all on function public.learning_group_attendance_save(uuid, date, time, time, uuid, text, time) from public, anon;

grant execute on function public.staff_is_group_mentor(uuid, uuid)                    to authenticated, service_role;
grant execute on function public.staff_can_record_school_attendance(uuid, uuid)       to authenticated, service_role;
grant execute on function public.staff_can_record_school_attendance_group(uuid, uuid) to authenticated, service_role;
grant execute on function public.staff_can_record_lg_attendance(uuid, uuid)           to authenticated, service_role;
grant execute on function public.student_effective_school_status(uuid, date)          to authenticated, service_role;
grant execute on function public.school_attendance_roster(uuid, date)                 to authenticated;
grant execute on function public.school_attendance_counts(uuid, date)                 to authenticated;
grant execute on function public.school_attendance_overview(date)                     to authenticated;
grant execute on function public.learning_group_attendance_for_date(uuid, date)       to authenticated;
grant execute on function public.school_attendance_mark(uuid, date, text, time)       to authenticated;
grant execute on function public.school_attendance_clear(uuid, date)                  to authenticated;
grant execute on function public.school_attendance_bulk_mark_present(uuid, date)      to authenticated;
grant execute on function public.student_day_plan_upsert(uuid, date, time, time, text) to authenticated;
grant execute on function public.student_day_plan_delete(uuid, date)                  to authenticated;
grant execute on function public.learning_group_attendance_save(uuid, date, time, time, uuid, text, time) to authenticated;
