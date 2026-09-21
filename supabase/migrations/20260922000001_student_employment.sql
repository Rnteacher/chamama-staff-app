-- ============================================================================
-- Migration 20260922000001: STUDENT EMPLOYMENT MANAGEMENT (phase 3)
--
-- Adds:
--   app_role 'employment_coordinator'  (רכז/ת תעסוקה) — real DB role.
--   students.school_year               canonical school year (1=א 2=ב 3=ג 4=ד);
--                                      employment eligibility = years 2..4.
--   student_employment_placements      workplace history (one current active
--                                      placement per student, history kept).
--   student_employment_weekly_slots    planned recurring work days
--                                      (same weekday convention as meetings /
--                                      learning groups: 0=Sunday, wall-clock
--                                      Asia/Jerusalem).
--   student_employment_exceptions      date-specific overrides:
--                                      add / cancel / modify for one date.
--   student_employment_work_logs       ACTUAL hours worked. The cumulative
--                                      total is always SUM(duration_minutes)
--                                      of logs — never an editable number.
--
-- Canonical resolver: student_expected_work_window(student, date) — the ONE
-- function attendance (phase 4) will consume. The unified student schedule
-- and the meeting conflict checker both use it; no second logic path.
--
-- Permissions: employment_coordinator / leadership / super_admin mutate via
-- narrow security-definer RPCs (audit inside). Other authorized staff read
-- summaries per normal student visibility, no mutation. No anon access.
-- Audit metadata contains ids/names/timestamps only — never contact details
-- or notes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Role: employment_coordinator (added to the existing enum — real integration
-- with user_roles / staff_has_role / admin_create_staff; not a UI title).
-- NOTE: the enum value is added and referenced (in function bodies only)
-- within this migration; body validation is deferred to runtime because
-- PostgreSQL refuses to USE a freshly-added enum value in the same txn.
-- ---------------------------------------------------------------------------
set check_function_bodies = off;

alter type public.app_role add value if not exists 'employment_coordinator'
  after 'project_coordinator';

-- ---------------------------------------------------------------------------
-- Canonical school year on students (none existed before — this becomes THE
-- field). 1=א 2=ב 3=ג 4=ד; null = unknown.
-- ---------------------------------------------------------------------------
alter table public.students
  add column if not exists school_year smallint
    check (school_year is null or school_year between 1 and 4);

comment on column public.students.school_year is
  'Canonical school year (כיתה): 1=א, 2=ב, 3=ג, 4=ד. Employment eligibility = 2..4. '
  'Pre-deploy data check: NO pre-existing canonical year source existed and none can be '
  'inferred reliably, so existing students ship with school_year = NULL — surfaced as '
  '"שנה לא הוגדרה" in the employment screen (never hidden) and set explicitly by '
  'leadership/super_admin via admin_set_student_school_year. No backfill guessing.';

create index if not exists idx_students_school_year on public.students (school_year);

-- ============================================================================
-- student_employment_placements — where a student works (with history).
-- A partial unique index enforces "normally ONE current active placement";
-- creating a new placement auto-ends the previous one (history preserved).
-- ============================================================================
create table public.student_employment_placements (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.students (id) on delete cascade,
  workplace_name      text not null check (length(btrim(workplace_name)) between 1 and 120),
  contact_name        text check (contact_name is null or length(btrim(contact_name)) <= 120),
  contact_phone       text check (contact_phone is null or length(btrim(contact_phone)) <= 30),
  start_date          date not null,
  end_date            date check (end_date is null or end_date >= start_date),
  is_active           boolean not null default true,
  notes               text check (notes is null or length(btrim(notes)) <= 1000),
  created_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.student_employment_placements is
  'Employment placements. One currently-active placement per student '
  '(partial unique index); ended placements remain as history.';

-- one ACTIVE placement per student (history rows are inactive)
create unique index idx_employment_placement_one_active
  on public.student_employment_placements (student_id)
  where is_active;

-- composite key enabling work logs to guarantee placement↔student integrity
alter table public.student_employment_placements
  add constraint employment_placement_id_student unique (id, student_id);

create index idx_employment_placements_student on public.student_employment_placements (student_id);
create index idx_employment_placements_active  on public.student_employment_placements (is_active, start_date);

-- ============================================================================
-- student_employment_weekly_slots — planned recurring work days.
-- weekday convention identical to meetings / learning groups: 0=Sunday.
-- Wall-clock Jerusalem times; "expected at work instead of school".
-- ============================================================================
create table public.student_employment_weekly_slots (
  id           uuid primary key default gen_random_uuid(),
  placement_id uuid not null references public.student_employment_placements (id) on delete cascade,
  weekday      smallint not null check (weekday between 0 and 6),
  start_time   time not null,
  end_time     time not null,
  timezone     text not null default 'Asia/Jerusalem',
  constraint employment_slot_times_valid check (end_time > start_time),
  unique (placement_id, weekday, start_time, end_time)
);

create index idx_employment_slots_placement on public.student_employment_weekly_slots (placement_id, weekday);

-- ============================================================================
-- student_employment_exceptions — date-specific overrides of the weekly plan.
--   add    : works this date although not a normal weekly work day
--   cancel : does NOT work this date although it normally is one
--   modify : works this date with DIFFERENT hours
-- ONE row per (placement, date). The canonical resolver honors these.
-- ============================================================================
create table public.student_employment_exceptions (
  id           uuid primary key default gen_random_uuid(),
  placement_id uuid not null references public.student_employment_placements (id) on delete cascade,
  work_date    date not null,
  kind         text not null check (kind in ('add', 'cancel', 'modify')),
  start_time   time,
  end_time     time,
  note         text check (note is null or length(btrim(note)) <= 500),
  created_by_staff_id uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (placement_id, work_date),
  -- add/modify require a valid time window; cancel must not carry one
  constraint employment_exception_add_times check (
    kind <> 'add'
    or (start_time is not null and end_time is not null and end_time > start_time)
  ),
  constraint employment_exception_modify_times check (
    kind <> 'modify'
    or (start_time is not null and end_time is not null and end_time > start_time)
  ),
  constraint employment_exception_cancel_no_times check (
    kind <> 'cancel' or (start_time is null and end_time is null)
  )
);

create index idx_employment_exceptions_placement on public.student_employment_exceptions (placement_id, work_date);

-- ============================================================================
-- student_employment_work_logs — ACTUAL hours worked (source of truth for
-- cumulative progress). duration_minutes is THE canonical calculated value;
-- when start+end are provided it must equal the derived duration.
-- ============================================================================
create table public.student_employment_work_logs (
  id                  uuid primary key default gen_random_uuid(),
  placement_id        uuid not null,
  student_id          uuid not null references public.students (id) on delete cascade,
  work_date           date not null,
  start_time          time,
  end_time            time,
  duration_minutes    int  not null check (duration_minutes between 1 and 720), -- 12h/day bound
  note                text check (note is null or length(btrim(note)) <= 500),
  entered_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- contradictory values impossible: times given → duration must match
  constraint employment_log_times_duration check (
    start_time is null or end_time is null
    or duration_minutes = (extract(epoch from (end_time - start_time)) / 60)::int
  ),
  -- the log's student must be the placement's student (declarative integrity)
  constraint employment_log_placement_matches_student
    foreign key (placement_id, student_id)
    references public.student_employment_placements (id, student_id)
    on delete cascade
);

-- no accidental duplicate log for the same period (NULL start treated as 00:00)
create unique index idx_employment_log_unique_period
  on public.student_employment_work_logs (placement_id, work_date, coalesce(start_time, '00:00'::time));

create index idx_employment_logs_student_date on public.student_employment_work_logs (student_id, work_date);
create index idx_employment_logs_placement    on public.student_employment_work_logs (placement_id, work_date);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'student_employment_placements',
    'student_employment_weekly_slots',
    'student_employment_exceptions',
    'student_employment_work_logs'
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
-- TIME COMPOSITION — reuse the phase-2 Jerusalem composer (wall-clock date +
-- time → absolute instant). A 08:30 work slot stays 08:30 across DST.
-- ============================================================================

-- ============================================================================
-- CANONICAL "EXPECTED AT WORK" RESOLVER (one function — attendance phase 4
-- consumes exactly this; the unified schedule and conflict checker reuse it).
--
-- Returns 0..n rows for the given student + Jerusalem date:
--   weekly slot rows (source='weekly') or an override row (source='override').
-- Honors: active placement covering the date, weekly slots, add/cancel/modify
-- exceptions. No rows → not expected at work.
-- ============================================================================
create or replace function public.student_expected_work_window(
  p_student_id uuid,
  p_date date
)
returns table (
  placement_id   uuid,
  workplace_name text,
  start_time     time,
  end_time       time,
  source         text
)
language sql
stable
security definer
set search_path = public
as $$
  with placement as (
    select p.id, p.workplace_name
      from public.student_employment_placements p
     where p.student_id = p_student_id
       and p.is_active
       and p.start_date <= p_date
       and (p.end_date is null or p.end_date >= p_date)
     order by p.start_date desc
     limit 1
  ),
  exception_row as (
    select e.kind, e.start_time, e.end_time
      from public.student_employment_exceptions e
      join placement pl on pl.id = e.placement_id
     where e.work_date = p_date
     limit 1
  )
  -- cancelled: explicitly not working this date
  select pl.id, pl.workplace_name, null::time, null::time, 'override'::text
    from placement pl
    join exception_row x on x.kind = 'cancel'
  union all
  -- add/modify: date-specific window(s)
  select pl.id, pl.workplace_name, x.start_time, x.end_time, 'override'::text
    from placement pl
    join exception_row x on x.kind in ('add', 'modify')
  union all
  -- normal weekly slots — skipped when ANY date exception governs the day
  -- (cancel / add / modify fully replace the weekly plan for that date)
  select pl.id, pl.workplace_name, w.start_time, w.end_time, 'weekly'::text
    from placement pl
    join public.student_employment_weekly_slots w on w.placement_id = pl.id
   where w.weekday = extract(dow from p_date)::smallint
     and not exists (select 1 from exception_row x)
   order by 3;
$$;

-- ---------------------------------------------------------------------------
-- Boolean-shaped resolver RPC for callers that want a yes/no + details.
-- ---------------------------------------------------------------------------
create or replace function public.is_student_expected_at_work(
  p_student_id uuid,
  p_date date
)
returns table (
  expected       boolean,
  placement_id   uuid,
  workplace_name text,
  start_time     time,
  end_time       time,
  source         text
)
language sql
stable
security definer
set search_path = public
as $$
  select true, w.placement_id, w.workplace_name, w.start_time, w.end_time, w.source
    from public.student_expected_work_window(p_student_id, p_date) w
   where w.start_time is not null
   union all
   select false, null::uuid, null::text, null::time, null::time, null::text
    where not exists (
      select 1 from public.student_expected_work_window(p_student_id, p_date)
       where start_time is not null
    )
   limit 1;
$$;

-- ============================================================================
-- PERMISSION HELPER — employment mutation = employment_coordinator |
-- leadership | super_admin. Does NOT grant any broader student/profile
-- permission beyond what each role already has.
-- ============================================================================
create or replace function public.staff_can_manage_employment(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_has_role(p_staff_id, 'employment_coordinator')
      or public.staff_has_role(p_staff_id, 'leadership')
      or public.staff_has_role(p_staff_id, 'super_admin');
$$;

-- student is employment-eligible: canonical school year ב/ג/ד.
-- NULL (year never set) is deliberately NOT eligible — but NULL-year students
-- are still RETURNED by employment_admin_rows (surfaced as "שנה לא הוגדרה")
-- so existing students are never silently hidden; leadership/super_admin set
-- the year via admin_set_student_school_year. Year א stays ineligible.
create or replace function public.student_employment_eligible(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.students s
     where s.id = p_student_id
       and s.is_archived = false
       and s.school_year between 2 and 4
  );
$$;

-- ---------------------------------------------------------------------------
-- Set/clear a student's canonical school year. leadership / super_admin ONLY
-- (the employment coordinator sees the "שנה לא הוגדרה" report but cannot
-- change the year). No inference, no backfill guesswork — an explicit,
-- audited human decision per student.
-- p_year: 1..4, or NULL to clear (corrections).
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_student_school_year(
  p_student_id uuid,
  p_year smallint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_name text;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not (
    public.staff_has_role(v_staff, 'leadership')
    or public.staff_has_role(v_staff, 'super_admin')
  ) then
    raise exception 'Only leadership or super_admin can set a student school year'
      using errcode = '42501';
  end if;
  if p_year is not null and p_year not between 1 and 4 then
    raise exception 'שנת לימודים לא תקינה' using errcode = '23514';
  end if;

  select s.first_name || ' ' || s.last_name into v_name
    from public.students s where s.id = p_student_id;
  if not found then
    raise exception 'Student not found';
  end if;

  update public.students set school_year = p_year where id = p_student_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'student_school_year_set', 'student', p_student_id,
          jsonb_build_object('student_id', p_student_id, 'school_year', p_year));
  return true;
end;
$$;

-- ============================================================================
-- MANAGEMENT RPCs (employment_coordinator / leadership / super_admin;
-- authorization + validation + audit INSIDE; View-As blocked in the app layer)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create / update a placement (+ its weekly slots atomically).
-- p_slots jsonb: [{weekday, start_time "HH:MM", end_time "HH:MM"}]
-- Creating a NEW placement for a student who already has an active one
-- auto-ends the previous placement (is_active=false, end_date = new start-1)
-- and audits employment_placement_ended — history is never destroyed.
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_employment_placement(
  p_id uuid,
  p_student_id uuid,
  p_workplace_name text,
  p_contact_name text,
  p_contact_phone text,
  p_start_date date,
  p_end_date date,
  p_notes text,
  p_slots jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_name  text := btrim(coalesce(p_workplace_name, ''));
  v_pid   uuid := p_id;
  v_student uuid;
  v_created boolean := false;
  v_prev_active uuid;
  v_prev_name text;
  v_elem jsonb; v_wd int; v_st time; v_et time;
  i int; n int;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_employment(v_staff) then
    raise exception 'Only employment coordinator, leadership or super_admin can manage employment'
      using errcode = '42501';
  end if;

  if p_student_id is null or not public.student_employment_eligible(p_student_id) then
    raise exception 'ניתן לשבץ לעבודה רק חניכים בשכבות ב/ג/ד' using errcode = '23514';
  end if;
  select s.id into v_student from public.students s where s.id = p_student_id;

  if v_name = '' or length(v_name) > 120 then
    raise exception 'שם מקום העבודה נדרש (עד 120 תווים)' using errcode = '23514';
  end if;
  if p_start_date is null then
    raise exception 'תאריך התחלה נדרש' using errcode = '23514';
  end if;
  if p_end_date is not null and p_end_date < p_start_date then
    raise exception 'תאריך סיום חייב להיות מאוחר מתאריך ההתחלה' using errcode = '23514';
  end if;
  if coalesce(p_contact_name, '') <> '' and length(btrim(p_contact_name)) > 120 then
    raise exception 'שם איש קשר ארוך מדי' using errcode = '23514';
  end if;
  if coalesce(p_contact_phone, '') <> '' and length(btrim(p_contact_phone)) > 30 then
    raise exception 'טלפון איש קשר ארוך מדי' using errcode = '23514';
  end if;

  -- ---- slots validation ----
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    raise exception 'סלוטים לא תקינים' using errcode = '23514';
  end if;
  n := jsonb_array_length(p_slots);
  if n > 28 then
    raise exception 'יותר מדי ימי עבודה' using errcode = '23514';
  end if;
  for i in 0 .. n - 1 loop
    v_elem := p_slots -> i;
    v_wd := (v_elem ->> 'weekday')::int;
    if v_wd is null or v_wd < 0 or v_wd > 6 then
      raise exception 'יום בשבוע לא תקין' using errcode = '23514';
    end if;
    v_st := (v_elem ->> 'start_time')::time;
    v_et := (v_elem ->> 'end_time')::time;
    if v_st is null or v_et is null or v_et <= v_st then
      raise exception 'שעות עבודה לא תקינות (הסיום חייב להיות אחרי ההתחלה)'
        using errcode = '23514';
    end if;
  end loop;

  -- ---- upsert ----
  if v_pid is null then
    -- auto-end any current active placement (history preserved)
    select pl.id, pl.workplace_name into v_prev_active, v_prev_name
      from public.student_employment_placements pl
     where pl.student_id = p_student_id and pl.is_active
     limit 1;
    if v_prev_active is not null then
      update public.student_employment_placements
         set is_active = false,
             end_date = p_start_date - 1
       where id = v_prev_active;
      insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
      values (v_staff, 'employment_placement_ended', 'employment_placement', v_prev_active,
              jsonb_build_object('student_id', p_student_id,
                                 'workplace', v_prev_name,
                                 'ended_on', p_start_date - 1));
    end if;

    insert into public.student_employment_placements
      (student_id, workplace_name, contact_name, contact_phone,
       start_date, end_date, is_active, notes, created_by_staff_id)
    values
      (p_student_id, v_name, nullif(btrim(coalesce(p_contact_name, '')), ''),
       nullif(btrim(coalesce(p_contact_phone, '')), ''),
       p_start_date, p_end_date, true,
       nullif(btrim(coalesce(p_notes, '')), ''), v_staff)
    returning id into v_pid;
    v_created := true;
  else
    update public.student_employment_placements
       set workplace_name = v_name,
           contact_name   = nullif(btrim(coalesce(p_contact_name, '')), ''),
           contact_phone  = nullif(btrim(coalesce(p_contact_phone, '')), ''),
           start_date     = p_start_date,
           end_date       = p_end_date,
           notes          = nullif(btrim(coalesce(p_notes, '')), '')
     where id = v_pid
     returning student_id into v_student;
    if not found then
      raise exception 'Placement not found';
    end if;
    if v_student <> p_student_id then
      raise exception 'Placement/student mismatch' using errcode = '23514';
    end if;
  end if;

  -- replace weekly slots
  delete from public.student_employment_weekly_slots where placement_id = v_pid;
  insert into public.student_employment_weekly_slots
    (placement_id, weekday, start_time, end_time)
  select v_pid,
         (s ->> 'weekday')::int,
         (s ->> 'start_time')::time,
         (s ->> 'end_time')::time
    from jsonb_array_elements(p_slots) s;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff,
          case when v_created then 'employment_placement_created'
               else 'employment_placement_updated' end,
          'employment_placement', v_pid,
          jsonb_build_object('student_id', p_student_id, 'workplace', v_name,
                             'slots', n));

  if not v_created then
    -- slot edits on an existing placement are audited as schedule updates
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'employment_schedule_updated', 'employment_placement', v_pid,
            jsonb_build_object('student_id', p_student_id, 'slots', n));
  end if;

  return jsonb_build_object('id', v_pid, 'created', v_created);
end;
$$;

-- end a placement (keeps history; logs remain for totals)
create or replace function public.admin_end_employment_placement(
  p_placement_id uuid,
  p_end_date date
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_student uuid;
  v_name text;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_employment(v_staff) then
    raise exception 'Only employment coordinator, leadership or super_admin can manage employment'
      using errcode = '42501';
  end if;

  select pl.student_id, pl.workplace_name into v_student, v_name
    from public.student_employment_placements pl
   where pl.id = p_placement_id;
  if not found then
    raise exception 'Placement not found';
  end if;

  update public.student_employment_placements
     set is_active = false,
         end_date = coalesce(p_end_date, current_date)
   where id = p_placement_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'employment_placement_ended', 'employment_placement', p_placement_id,
          jsonb_build_object('student_id', v_student, 'workplace', v_name,
                             'ended_on', coalesce(p_end_date, current_date)));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- date-specific exception (add / cancel / modify)
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_employment_exception(
  p_id uuid,
  p_placement_id uuid,
  p_work_date date,
  p_kind text,
  p_start_time time,
  p_end_time time,
  p_note text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_eid uuid := p_id;
  v_placement public.student_employment_placements;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_employment(v_staff) then
    raise exception 'Only employment coordinator, leadership or super_admin can manage employment'
      using errcode = '42501';
  end if;

  select * into v_placement from public.student_employment_placements
   where id = p_placement_id;
  if not found then
    raise exception 'Placement not found';
  end if;
  if p_work_date is null then
    raise exception 'תאריך נדרש' using errcode = '23514';
  end if;
  if p_work_date < v_placement.start_date
     or (v_placement.end_date is not null and p_work_date > v_placement.end_date) then
    raise exception 'התאריך חייב להיות בתוך תקופת ההעסקה' using errcode = '23514';
  end if;
  if p_kind not in ('add', 'cancel', 'modify') then
    raise exception 'סוג חריגה לא תקין' using errcode = '23514';
  end if;
  if p_kind = 'cancel' then
    if p_start_time is not null or p_end_time is not null then
      raise exception 'ביטול יום עבודה לא מקבל שעות' using errcode = '23514';
    end if;
  else
    if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
      raise exception 'שעות עבודה לא תקינות' using errcode = '23514';
    end if;
  end if;

  if v_eid is null then
    insert into public.student_employment_exceptions
      (placement_id, work_date, kind, start_time, end_time, note, created_by_staff_id)
    values
      (p_placement_id, p_work_date, p_kind, p_start_time, p_end_time,
       nullif(btrim(coalesce(p_note, '')), ''), v_staff)
    returning id into v_eid;
  else
    update public.student_employment_exceptions
       set work_date = p_work_date,
           kind = p_kind,
           start_time = p_start_time,
           end_time = p_end_time,
           note = nullif(btrim(coalesce(p_note, '')), '')
     where id = v_eid
     returning placement_id into v_placement.id;
    if not found then
      raise exception 'Exception not found';
    end if;
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'employment_schedule_updated', 'employment_exception', v_eid,
          jsonb_build_object('placement_id', p_placement_id,
                             'work_date', p_work_date, 'kind', p_kind));
  return v_eid;
end;
$$;

create or replace function public.admin_delete_employment_exception(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_placement uuid;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_employment(v_staff) then
    raise exception 'Only employment coordinator, leadership or super_admin can manage employment'
      using errcode = '42501';
  end if;
  select placement_id into v_placement from public.student_employment_exceptions
   where id = p_id;
  if not found then
    raise exception 'Exception not found';
  end if;
  delete from public.student_employment_exceptions where id = p_id;
  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'employment_schedule_updated', 'employment_exception', p_id,
          jsonb_build_object('placement_id', v_placement, 'deleted', true));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- work logs — actual hours. start+end → duration derived (canonical).
-- p_duration_minutes is accepted ONLY when start or end is missing.
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_work_log(
  p_id uuid,
  p_placement_id uuid,
  p_work_date date,
  p_start_time time,
  p_end_time time,
  p_duration_minutes int,
  p_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_lid uuid := p_id;
  v_placement public.student_employment_placements;
  v_duration int;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_employment(v_staff) then
    raise exception 'Only employment coordinator, leadership or super_admin can manage employment'
      using errcode = '42501';
  end if;

  select * into v_placement from public.student_employment_placements
   where id = p_placement_id;
  if not found then
    raise exception 'Placement not found';
  end if;
  if p_work_date is null then
    raise exception 'תאריך עבודה נדרש' using errcode = '23514';
  end if;
  if p_work_date < v_placement.start_date
     or (v_placement.end_date is not null and p_work_date > v_placement.end_date) then
    raise exception 'תאריך העבודה חייב להיות בתוך תקופת ההעסקה' using errcode = '23514';
  end if;

  if p_start_time is not null and p_end_time is not null then
    if p_end_time <= p_start_time then
      raise exception 'שעת סיום חייבת להיות אחרי שעת ההתחלה' using errcode = '23514';
    end if;
    v_duration := (extract(epoch from (p_end_time - p_start_time)) / 60)::int;
    if p_duration_minutes is not null and p_duration_minutes <> v_duration then
      raise exception 'משך מדווח אינו תואם לשעות שהוזנו' using errcode = '23514';
    end if;
  else
    v_duration := p_duration_minutes;
  end if;

  if v_duration is null or v_duration < 1 or v_duration > 720 then
    raise exception 'משך העבודה חייב להיות בין דקה ל־12 שעות' using errcode = '23514';
  end if;

  if v_lid is null then
    insert into public.student_employment_work_logs
      (placement_id, student_id, work_date, start_time, end_time,
       duration_minutes, note, entered_by_staff_id)
    values
      (p_placement_id, v_placement.student_id, p_work_date, p_start_time, p_end_time,
       v_duration, nullif(btrim(coalesce(p_note, '')), ''), v_staff)
    returning id into v_lid;
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'employment_work_log_created', 'employment_work_log', v_lid,
            jsonb_build_object('student_id', v_placement.student_id,
                               'work_date', p_work_date, 'minutes', v_duration));
  else
    update public.student_employment_work_logs
       set work_date = p_work_date,
           start_time = p_start_time,
           end_time = p_end_time,
           duration_minutes = v_duration,
           note = nullif(btrim(coalesce(p_note, '')), '')
     where id = v_lid
     returning placement_id, student_id into v_placement.id, v_placement.student_id;
    if not found then
      raise exception 'Work log not found';
    end if;
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'employment_work_log_updated', 'employment_work_log', v_lid,
            jsonb_build_object('student_id', v_placement.student_id,
                               'work_date', p_work_date, 'minutes', v_duration));
  end if;

  return jsonb_build_object('id', v_lid, 'minutes', v_duration);
end;
$$;

create or replace function public.admin_delete_work_log(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_student uuid;
  v_date date;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_employment(v_staff) then
    raise exception 'Only employment coordinator, leadership or super_admin can manage employment'
      using errcode = '42501';
  end if;
  select student_id, work_date into v_student, v_date
    from public.student_employment_work_logs where id = p_id;
  if not found then
    raise exception 'Work log not found';
  end if;
  delete from public.student_employment_work_logs where id = p_id;
  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'employment_work_log_deleted', 'employment_work_log', p_id,
          jsonb_build_object('student_id', v_student, 'work_date', v_date));
  return true;
end;
$$;

-- ============================================================================
-- READ RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- cumulative actual minutes per student (THE progress value — derived from
-- work logs, never an editable number)
-- ---------------------------------------------------------------------------
create or replace function public.student_employment_minutes(p_student_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(l.duration_minutes), 0)::int
    from public.student_employment_work_logs l
   where l.student_id = p_student_id;
$$;

-- ---------------------------------------------------------------------------
-- student-page employment summary. Contact details are returned ONLY to
-- employment managers (coordinator/leadership/super_admin) — sensitive
-- contact stays off broad surfaces.
-- ---------------------------------------------------------------------------
create or replace function public.student_employment_overview(
  p_student_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_can_manage boolean := public.staff_can_manage_employment(v_staff);
  v_place record;
  v_minutes int;
  v_slots jsonb;
  v_exceptions jsonb;
  v_recent jsonb;
begin
  select * into v_place
    from public.student_employment_placements pl
   where pl.student_id = p_student_id
   order by pl.is_active desc, pl.start_date desc
   limit 1;

  v_minutes := public.student_employment_minutes(p_student_id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'weekday', w.weekday, 'start_time', w.start_time, 'end_time', w.end_time)
           order by w.weekday, w.start_time), '[]'::jsonb)
    into v_slots
    from public.student_employment_weekly_slots w
   where v_place.id is not null and w.placement_id = v_place.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'work_date', e.work_date, 'kind', e.kind,
           'start_time', e.start_time, 'end_time', e.end_time)
           order by e.work_date), '[]'::jsonb)
    into v_exceptions
    from public.student_employment_exceptions e
   where v_place.id is not null and e.placement_id = v_place.id
     and e.work_date >= current_date - 30
     and e.work_date <= current_date + 60;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'work_date', l.work_date, 'start_time', l.start_time,
           'end_time', l.end_time, 'duration_minutes', l.duration_minutes,
           'note', case when v_can_manage then l.note else null end)
           order by l.work_date desc, l.created_at desc), '[]'::jsonb)
    into v_recent
    from (select * from public.student_employment_work_logs
           where student_id = p_student_id
           order by work_date desc, created_at desc
           limit 10) l;

  return jsonb_build_object(
    'eligible', public.student_employment_eligible(p_student_id),
    'school_year', (select s.school_year from public.students s where s.id = p_student_id),
    'placement', case when v_place.id is null then null else jsonb_build_object(
      'id', v_place.id,
      'workplace_name', v_place.workplace_name,
      'contact_name', case when v_can_manage then v_place.contact_name else null end,
      'contact_phone', case when v_can_manage then v_place.contact_phone else null end,
      'start_date', v_place.start_date,
      'end_date', v_place.end_date,
      'is_active', v_place.is_active,
      'notes', case when v_can_manage then v_place.notes else null end
    ) end,
    'weekly_slots', v_slots,
    'exceptions', v_exceptions,
    'total_minutes', v_minutes,
    'target_minutes', 12000,
    'recent_logs', v_recent,
    'can_manage', v_can_manage
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- management table rows: one row per employment-RELEVANT student:
-- years ב/ג/ד PLUS students whose year was never set (school_year IS NULL) —
-- existing students must be surfaced as "שנה לא הוגדרה", never silently
-- hidden. Year-א students are excluded (explicitly ineligible for the
-- 200-hour requirement).
-- Filters server-side:
--   p_year    : 2|3|4 — or 0 meaning "year not set"
--   p_status  : 'active' | 'ended' | 'none' | null (all)
--   p_progress: 'below' | 'at' | 'above' | null (all) — vs 200h target
-- ---------------------------------------------------------------------------
create or replace function public.employment_admin_rows(
  p_group_id uuid default null,
  p_year smallint default null,
  p_workplace text default null,
  p_status text default null,
  p_progress text default null
)
returns table (
  student_id        uuid,
  student_name      text,
  group_name        text,
  school_year       smallint,
  placement_id      uuid,
  workplace_name    text,
  placement_active  boolean,
  slots_summary     text,
  total_minutes     int,
  target_minutes    int
)
language sql
stable
security definer
set search_path = public
as $$
  with weekdays as (
    select unnest(array['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת']) as name,
           generate_series(0, 6) as idx
  )
  select s.id,
         s.first_name || ' ' || s.last_name,
         g.name,
         s.school_year,
         pl.id,
         pl.workplace_name,
         pl.is_active,
         coalesce((
           select string_agg('יום ' || wd.name || ' ' ||
                    to_char(w.start_time, 'HH24:MI') || '–' || to_char(w.end_time, 'HH24:MI'),
                    ' · ' order by w.weekday, w.start_time)
             from public.student_employment_weekly_slots w
             join weekdays wd on wd.idx = w.weekday
            where w.placement_id = pl.id
         ), '') as slots_summary,
         public.student_employment_minutes(s.id) as total_minutes,
         12000 as target_minutes
    from public.students s
    left join public.greenhouse_groups g on g.id = s.group_id
    left join lateral (
      select * from public.student_employment_placements pl2
       where pl2.student_id = s.id
       order by pl2.is_active desc, pl2.start_date desc
       limit 1
    ) pl on true
   where s.is_archived = false
     and (s.school_year between 2 and 4 or s.school_year is null)
     and (p_group_id is null or s.group_id = p_group_id)
     and (p_year is null
          or (p_year = 0 and s.school_year is null)
          or s.school_year = p_year)
     and (p_workplace is null or pl.workplace_name ilike '%' || btrim(p_workplace) || '%')
     and (
       p_status is null
       or (p_status = 'active' and pl.is_active)
       or (p_status = 'ended' and pl.id is not null and not pl.is_active)
       or (p_status = 'none' and pl.id is null)
     )
     and (
       p_progress is null
       or (p_progress = 'below' and public.student_employment_minutes(s.id) < 12000)
       or (p_progress = 'at'    and public.student_employment_minutes(s.id) = 12000)
       or (p_progress = 'above' and public.student_employment_minutes(s.id) > 12000)
     )
   order by s.first_name, s.last_name;
$$;

-- ============================================================================
-- UNIFIED STUDENT SCHEDULE — employment added as another source (same item
-- shape: calendar | meeting | learning_group | employment). Staff schedules
-- intentionally unchanged (no staff-facing employment source yet).
-- ============================================================================
create or replace function public.student_day_schedule(
  p_student_id uuid,
  p_date date
)
returns table (
  source_type text,
  source_id   uuid,
  title       text,
  start_at    timestamptz,
  end_at      timestamptz,
  is_all_day  boolean,
  context     text,
  link_path   text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  -- 1. calendar events relevant to this student (audience-resolved)
  select 'calendar_event'::text, o.event_id, o.title,
         o.occurrence_start, o.occurrence_end, o.is_all_day,
         coalesce((select string_agg(distinct lbl.label, ' · ')
                     from public.calendar_event_audiences a
                     left join public.greenhouse_groups g on g.id = a.greenhouse_group_id
                     left join public.majors m on m.id = a.major_id
                     left join public.learning_groups lg on lg.id = a.learning_group_id
                     left join public.profiles p on p.id = a.staff_id
                     left join lateral (
                       select case a.audience_type
                         when 'everyone' then 'כולם'
                         when 'staff_only' then 'צוות בלבד'
                         when 'home_group' then 'קבוצת אם: ' || g.name
                         when 'major' then 'מגמה: ' || m.name
                         when 'learning_group' then 'קבוצת למידה: ' || lg.name
                         when 'staff_member' then 'צוות: ' || coalesce(p.full_name, '')
                       end as label
                     ) lbl on true
                    where a.event_id = o.event_id), '') as context,
         ('/calendar?date=' || to_char((o.occurrence_start at time zone 'Asia/Jerusalem')::date, 'YYYY-MM-DD'))::text
           as link_path
    from public.calendar_event_occurrences(
           public.compose_jerusalem(p_date, '00:00'),
           public.compose_jerusalem(p_date, '23:59')
         ) o
   where public.calendar_event_applies_to_student(o.event_id, p_student_id)

  union all

  -- 2. mentor/master meetings — 60-minute assumed window
  select 'meeting'::text, o.id,
         ('פגישת ' || (case s.context when 'mentor' then 'מנטור' else 'מאסטר' end)
           || ' · ' || coalesce(st.full_name, ''))::text,
         o.due_at,
         o.due_at + interval '60 minutes',
         false,
         ('מדריך/ה: ' || coalesce(st.full_name, ''))::text,
         ('/students/' || s.student_id)::text
    from public.meeting_occurrences o
    join public.meeting_schedules s on s.id = o.schedule_id
    join public.profiles st on st.id = s.staff_id
   where s.student_id = p_student_id
     and s.is_active
     and (o.due_at at time zone 'Asia/Jerusalem')::date = p_date

  union all

  -- 3. learning groups with an active membership
  select 'learning_group'::text, g.id,
         ('קבוצת למידה · ' || g.name)::text,
         public.compose_jerusalem(p_date, sl.start_time),
         public.compose_jerusalem(p_date, sl.end_time),
         false,
         'קבוצת למידה'::text,
         ('/groups/learning/' || g.id)::text
    from public.learning_group_weekly_slots sl
    join public.learning_groups g on g.id = sl.learning_group_id
   where sl.weekday = extract(dow from p_date)::smallint
     and exists (
       select 1 from public.learning_group_memberships m
        where m.learning_group_id = g.id
          and m.student_id = p_student_id
          and m.ended_at is null
     )

  union all

  -- 4. employment — planned work periods resolved canonically (weekly slots
  --    + date exceptions). Wall-clock composed → DST-safe.
  select 'employment'::text, w.placement_id,
         ('עבודה — ' || w.workplace_name)::text,
         public.compose_jerusalem(p_date, w.start_time),
         public.compose_jerusalem(p_date, w.end_time),
         false,
         case w.source when 'weekly' then 'יום עבודה מתוכנן'
                       else 'יום עבודה (חריגה)' end::text,
         ('/students/' || p_student_id)::text
    from public.student_expected_work_window(p_student_id, p_date) w
   where w.start_time is not null;
end;
$$;

-- ============================================================================
-- MEETING CONFLICT CHECK — employment branch added to the SAME resolver
-- (no separate employment-only checker). Overlap uses wall-clock slots like
-- learning groups; touching boundaries are NOT conflicts.
-- ============================================================================
create or replace function public.check_student_meeting_conflicts(
  p_student_id uuid,
  p_dates date[],
  p_start_time time,
  p_duration_minutes int default 60,
  p_exclude_occurrence_id uuid default null
)
returns table (
  conflict_date date,
  source_type   text,
  source_id     uuid,
  title         text,
  start_at      timestamptz,
  end_at        timestamptz,
  description   text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_duration interval := make_interval(mins => coalesce(greatest(p_duration_minutes, 1), 60));
  d date;
  v_start timestamptz;
  v_end timestamptz;
  v_wd smallint;
begin
  if p_student_id is null or p_dates is null or p_start_time is null then
    return;
  end if;

  foreach d in array p_dates loop
    v_start := public.compose_jerusalem(d, p_start_time);
    v_end := v_start + v_duration;
    v_wd := extract(dow from d)::smallint;

    return query
    -- calendar events applying to the student
    select d, 'calendar_event'::text, o.event_id, o.title,
           o.occurrence_start, o.occurrence_end,
           format('האירוע "%s" (%s–%s)', o.title,
                  to_char((o.occurrence_start at time zone 'Asia/Jerusalem')::time, 'HH24:MI'),
                  to_char((o.occurrence_end at time zone 'Asia/Jerusalem')::time, 'HH24:MI'))
      from public.calendar_event_occurrences(v_start - interval '1 day', v_end + interval '1 day') o
     where public.calendar_event_applies_to_student(o.event_id, p_student_id)
       and o.occurrence_start < v_end
       and o.occurrence_end > v_start
    union all
    -- learning groups with an active membership (wall-clock overlap)
    select d, 'learning_group'::text, g.id, g.name,
           public.compose_jerusalem(d, sl.start_time),
           public.compose_jerusalem(d, sl.end_time),
           format('קבוצת הלמידה "%s" (%s–%s)', g.name,
                  to_char(sl.start_time, 'HH24:MI'), to_char(sl.end_time, 'HH24:MI'))
      from public.learning_group_weekly_slots sl
      join public.learning_groups g on g.id = sl.learning_group_id
     where sl.weekday = v_wd
       and sl.start_time < (p_start_time + v_duration)::time
       and p_start_time < sl.end_time
       and exists (
         select 1 from public.learning_group_memberships m
          where m.learning_group_id = g.id
            and m.student_id = p_student_id
            and m.ended_at is null
       )
    union all
    -- PLANNED WORK: the canonical expected-at-work resolver
    select d, 'employment'::text, w.placement_id,
           ('עבודה — ' || w.workplace_name)::text,
           public.compose_jerusalem(d, w.start_time),
           public.compose_jerusalem(d, w.end_time),
           format('החניך/ה נמצא/ת בעבודה ב%s (%s–%s)', w.workplace_name,
                  to_char(w.start_time, 'HH24:MI'), to_char(w.end_time, 'HH24:MI'))
      from public.student_expected_work_window(p_student_id, d) w
     where w.start_time is not null
       and w.start_time < (p_start_time + v_duration)::time
       and p_start_time < w.end_time
    union all
    -- the student's own scheduled meetings (both contexts)
    select d, 'meeting'::text, o.id,
           ('פגישת ' || (case s.context when 'mentor' then 'מנטור' else 'מאסטר' end))::text,
           o.due_at, o.due_at + interval '60 minutes',
           format('פגישת %s קבועה (%s)',
                  case s.context when 'mentor' then 'מנטור' else 'מאסטר' end,
                  to_char((o.due_at at time zone 'Asia/Jerusalem')::time, 'HH24:MI'))
      from public.meeting_occurrences o
      join public.meeting_schedules s on s.id = o.schedule_id
     where s.student_id = p_student_id
       and s.is_active
       and o.id is distinct from p_exclude_occurrence_id
       and (o.due_at at time zone 'Asia/Jerusalem')::date = d
       and o.due_at < v_end
       and o.due_at + interval '60 minutes' > v_start;
  end loop;
end;
$$;

-- ============================================================================
-- RLS — read for authorized staff (summaries per normal student visibility);
-- NO direct-mutation policies: all writes flow through the RPCs above.
-- ============================================================================
alter table public.student_employment_placements  enable row level security;
alter table public.student_employment_weekly_slots enable row level security;
alter table public.student_employment_exceptions   enable row level security;
alter table public.student_employment_work_logs    enable row level security;

create policy "employment_placements_select_staff" on public.student_employment_placements
  for select to authenticated using (public.is_authorized_staff());

create policy "employment_slots_select_staff" on public.student_employment_weekly_slots
  for select to authenticated using (public.is_authorized_staff());

create policy "employment_exceptions_select_staff" on public.student_employment_exceptions
  for select to authenticated using (public.is_authorized_staff());

create policy "employment_logs_select_staff" on public.student_employment_work_logs
  for select to authenticated using (public.is_authorized_staff());

-- ============================================================================
-- Grants
-- ============================================================================
grant select on public.student_employment_placements,
                public.student_employment_weekly_slots,
                public.student_employment_exceptions,
                public.student_employment_work_logs to authenticated;
grant all on public.student_employment_placements,
             public.student_employment_weekly_slots,
             public.student_employment_exceptions,
             public.student_employment_work_logs to service_role;

revoke all on function public.student_expected_work_window(uuid, date)                    from public, anon;
revoke all on function public.is_student_expected_at_work(uuid, date)                     from public, anon;
revoke all on function public.staff_can_manage_employment(uuid)                           from public, anon;
revoke all on function public.student_employment_eligible(uuid)                           from public, anon;
revoke all on function public.admin_set_student_school_year(uuid, smallint)               from public, anon;
revoke all on function public.admin_upsert_employment_placement(uuid, uuid, text, text, text, date, date, text, jsonb) from public, anon;
revoke all on function public.admin_end_employment_placement(uuid, date)                  from public, anon;
revoke all on function public.admin_upsert_employment_exception(uuid, uuid, date, text, time, time, text) from public, anon;
revoke all on function public.admin_delete_employment_exception(uuid)                     from public, anon;
revoke all on function public.admin_upsert_work_log(uuid, uuid, date, time, time, int, text) from public, anon;
revoke all on function public.admin_delete_work_log(uuid)                                 from public, anon;
revoke all on function public.student_employment_minutes(uuid)                            from public, anon;
revoke all on function public.student_employment_overview(uuid)                           from public, anon;
revoke all on function public.employment_admin_rows(uuid, smallint, text, text, text)     from public, anon;

grant execute on function public.student_expected_work_window(uuid, date)                 to authenticated, service_role;
grant execute on function public.is_student_expected_at_work(uuid, date)                  to authenticated, service_role;
grant execute on function public.staff_can_manage_employment(uuid)                        to authenticated, service_role;
grant execute on function public.student_employment_eligible(uuid)                        to authenticated, service_role;
grant execute on function public.admin_set_student_school_year(uuid, smallint)            to authenticated;
grant execute on function public.admin_upsert_employment_placement(uuid, uuid, text, text, text, date, date, text, jsonb) to authenticated;
grant execute on function public.admin_end_employment_placement(uuid, date)               to authenticated;
grant execute on function public.admin_upsert_employment_exception(uuid, uuid, date, text, time, time, text) to authenticated;
grant execute on function public.admin_delete_employment_exception(uuid)                  to authenticated;
grant execute on function public.admin_upsert_work_log(uuid, uuid, date, time, time, int, text) to authenticated;
grant execute on function public.admin_delete_work_log(uuid)                              to authenticated;
grant execute on function public.student_employment_minutes(uuid)                         to authenticated, service_role;
grant execute on function public.student_employment_overview(uuid)                        to authenticated;
grant execute on function public.employment_admin_rows(uuid, smallint, text, text, text)  to authenticated;
