-- ============================================================================
-- Migration 20260921000004: LEARNING GROUPS + SHARED SCHEDULING FOUNDATION
--
-- Phase 1 of the daily-operations expansion. Future phases (calendar/events,
-- student employment, attendance) will REUSE the weekly-slot convention and
-- the overlap primitive defined here — they are NOT implemented yet.
--
-- Conventions (reused from the weekly-meetings model):
--   * weekday smallint 0=Sunday..6=Saturday (like JS Date.getDay())
--   * times are local Israel wall-clock ("HH:MM", Asia/Jerusalem semantics)
--   * touching boundaries (10:00–11:00 + 11:00–12:00) are NOT a conflict
--
-- Entities:
--   learning_groups                          — SEPARATE from greenhouse_groups
--   learning_group_weekly_slots              — 1+ weekly meeting slots/group
--   learning_group_staff_leaders             — multiple staff leaders
--   learning_group_student_leaders           — multiple student leaders
--   learning_group_memberships               — roster with PROVENANCE + history
--   learning_group_registration_windows      — public token-gated windows
--   learning_group_registration_window_groups— selectable groups per window
--   learning_group_registrations             — one submission per window+student
--
-- Permission model:
--   * create/edit group definition: leadership / super_admin (in-RPC check)
--   * membership add/remove: staff leaders OF THAT GROUP, leadership,
--     super_admin (in-RPC check). Student leaders get NO app permissions.
--   * clients have SELECT-only grants; every mutation runs through
--     security-definer RPCs that authorize + audit. View-As is blocked in the
--     app layer (assertNotViewAs) before any RPC is invoked.
--   * public registration runs ONLY through token-gated RPCs (no anon table
--     access), mirroring the hardened intake architecture.
--
-- Audit actions: learning_group_created, learning_group_updated,
--   learning_group_leaders_updated, learning_group_member_added,
--   learning_group_member_removed, learning_group_window_created,
--   learning_group_window_revoked, learning_group_window_deleted.
-- Metadata contains ids only — no sensitive free text.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- learning_groups — the conceptual entity
-- ---------------------------------------------------------------------------
create table public.learning_groups (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique check (length(btrim(name)) between 1 and 120),
  description         text check (description is null or length(btrim(description)) <= 500),
  is_active           boolean not null default true,
  created_by_staff_id uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_learning_groups_active on public.learning_groups (is_active);

-- ---------------------------------------------------------------------------
-- learning_group_weekly_slots — one group may have MULTIPLE weekly slots.
-- end > start; duplicate identical slots are impossible (unique).
-- Overlaps BETWEEN different groups are allowed globally — conflicts only
-- matter per-student at registration time.
-- ---------------------------------------------------------------------------
create table public.learning_group_weekly_slots (
  id                uuid primary key default gen_random_uuid(),
  learning_group_id uuid not null references public.learning_groups (id) on delete cascade,
  weekday           smallint not null check (weekday between 0 and 6), -- 0=Sunday
  start_time        time not null,
  end_time          time not null,
  timezone          text not null default 'Asia/Jerusalem',
  created_at        timestamptz not null default now(),
  constraint learning_group_slot_times_valid check (end_time > start_time),
  constraint learning_group_slot_unique
    unique (learning_group_id, weekday, start_time, end_time)
);

create index idx_learning_group_slots_group   on public.learning_group_weekly_slots (learning_group_id);
create index idx_learning_group_slots_weekday on public.learning_group_weekly_slots (weekday, start_time, end_time);

-- ---------------------------------------------------------------------------
-- leaders — multiple staff and/or multiple students per group
-- ---------------------------------------------------------------------------
create table public.learning_group_staff_leaders (
  learning_group_id uuid not null references public.learning_groups (id) on delete cascade,
  staff_id          uuid not null references public.profiles (id) on delete cascade,
  created_at        timestamptz not null default now(),
  primary key (learning_group_id, staff_id)
);

create index idx_lg_staff_leaders_staff on public.learning_group_staff_leaders (staff_id);

create table public.learning_group_student_leaders (
  learning_group_id uuid not null references public.learning_groups (id) on delete cascade,
  student_id        uuid not null references public.students (id) on delete cascade,
  created_at        timestamptz not null default now(),
  primary key (learning_group_id, student_id)
);

create index idx_lg_student_leaders_student on public.learning_group_student_leaders (student_id);

-- ---------------------------------------------------------------------------
-- learning_group_registration_windows — public token-gated links (same
-- proven security architecture as intake_windows: SHA-256 hash for lookup,
-- AES-256-GCM encrypted copy for recoverable Copy-Link, plaintext never at
-- rest). Selectable learning groups live in their own table.
-- ---------------------------------------------------------------------------
create table public.learning_group_registration_windows (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null check (length(btrim(title)) between 1 and 120),
  token_hash          text not null unique, -- sha256 hex of the raw public token
  encrypted_token     text,
  encryption_iv       text,
  encryption_tag      text,
  opens_at            timestamptz not null,
  closes_at           timestamptz not null,
  is_revoked          boolean not null default false,
  deleted_at          timestamptz,
  created_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint learning_group_window_times_valid check (opens_at < closes_at)
);

create table public.learning_group_registration_window_groups (
  registration_window_id uuid not null references public.learning_group_registration_windows (id) on delete cascade,
  learning_group_id      uuid not null references public.learning_groups (id) on delete cascade,
  primary key (registration_window_id, learning_group_id)
);

create index idx_lgreg_window_groups_group on public.learning_group_registration_window_groups (learning_group_id);

-- ---------------------------------------------------------------------------
-- learning_group_registrations — one submission per (window, student):
-- idempotent upsert = edit/resubmit. selected_group_ids preserves exactly
-- what was submitted (audit-friendly).
-- ---------------------------------------------------------------------------
create table public.learning_group_registrations (
  id                     uuid primary key default gen_random_uuid(),
  registration_window_id uuid not null references public.learning_group_registration_windows (id) on delete cascade,
  student_id             uuid not null references public.students (id) on delete cascade,
  home_group_id          uuid not null references public.greenhouse_groups (id),
  selected_group_ids     uuid[] not null default '{}',
  submitted_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (registration_window_id, student_id)
);

create index idx_lgreg_registrations_window  on public.learning_group_registrations (registration_window_id);
create index idx_lgreg_registrations_student on public.learning_group_registrations (student_id);

-- ---------------------------------------------------------------------------
-- learning_group_memberships — current roster + history + PROVENANCE.
-- source: 'registration' (created by a public registration submit — linked to
--         the owning registration row) or 'manual' (added by staff).
-- Resubmission synchronizes ONLY memberships of THAT registration; manually
-- added memberships are never destroyed by registration edits.
-- ended_at soft-ends: history is preserved, never destroyed.
-- ---------------------------------------------------------------------------
create table public.learning_group_memberships (
  id                uuid primary key default gen_random_uuid(),
  learning_group_id uuid not null references public.learning_groups (id) on delete cascade,
  student_id        uuid not null references public.students (id) on delete cascade,
  source            text not null check (source in ('registration', 'manual')),
  registration_id   uuid references public.learning_group_registrations (id) on delete set null,
  added_by_staff_id uuid references public.profiles (id) on delete set null,
  joined_at         timestamptz not null default now(),
  ended_at          timestamptz,
  created_at        timestamptz not null default now()
);

-- one ACTIVE membership per (group, student); historical (ended) rows remain
create unique index idx_lg_membership_active
  on public.learning_group_memberships (learning_group_id, student_id)
  where ended_at is null;

create index idx_lg_memberships_student  on public.learning_group_memberships (student_id);
create index idx_lg_memberships_group    on public.learning_group_memberships (learning_group_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (shared set_updated_at trigger from migration 0001)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'learning_groups',
    'learning_group_registration_windows',
    'learning_group_registrations'
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
-- SHARED WEEKLY-SLOT PRIMITIVE (single source of truth for overlap logic)
--
-- Two weekly slots conflict when: same weekday AND a.start < b.end AND
-- b.start < a.end. Touching boundaries are NOT a conflict. Future phases
-- (calendar, employment, attendance) extend conflict checks through THIS
-- function (or its TypeScript mirror in src/lib/schedule.ts) — never re-derive.
-- ============================================================================
create or replace function public.weekly_slots_overlap(
  p_a_weekday smallint,
  p_a_start   time,
  p_a_end     time,
  p_b_weekday smallint,
  p_b_start   time,
  p_b_end     time
)
returns boolean
language sql
immutable
as $$
  select p_a_weekday = p_b_weekday
     and p_a_start < p_b_end
     and p_b_start < p_a_end;
$$;

-- Do two sets of weekly slots overlap anywhere? (generic; future phases reuse)
create or replace function public.weekly_slot_sets_overlap(
  p_slots_a jsonb,
  p_slots_b jsonb
)
returns boolean
language plpgsql
immutable
as $$
declare
  a record;
  b record;
begin
  for a in select * from jsonb_to_recordset(p_slots_a)
             as x(weekday smallint, start_time time, end_time time)
  loop
    for b in select * from jsonb_to_recordset(p_slots_b)
               as y(weekday smallint, start_time time, end_time time)
    loop
      if public.weekly_slots_overlap(
           a.weekday, a.start_time, a.end_time,
           b.weekday, b.start_time, b.end_time) then
        return true;
      end if;
    end loop;
  end loop;
  return false;
end;
$$;

-- Hebrew weekday names (0=Sunday) for server-built validation messages
create or replace function public.weekday_name_he(p_weekday smallint)
returns text
language sql
immutable
as $$
  select (array['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'])[p_weekday + 1];
$$;

-- ============================================================================
-- PERMISSION HELPERS
-- ============================================================================

-- leadership OR super_admin: manages ALL learning groups
create or replace function public.staff_can_manage_all_learning_groups(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_staff_id is not null and (
    public.staff_has_role(p_staff_id, 'leadership')
    or public.staff_has_role(p_staff_id, 'super_admin')
  );
$$;

-- staff leader of THAT specific group
create or replace function public.staff_leads_learning_group(p_staff_id uuid, p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.learning_group_staff_leaders l
     where l.learning_group_id = p_group_id
       and l.staff_id = p_staff_id
  );
$$;

-- membership management: staff leaders of THAT group OR leadership/super_admin
create or replace function public.staff_can_manage_learning_group_membership(p_staff_id uuid, p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_can_manage_all_learning_groups(p_staff_id)
      or public.staff_leads_learning_group(p_staff_id, p_group_id);
$$;

-- ============================================================================
-- STAFF RPCs (security definer; authorization + audit INSIDE the function)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create / edit a learning group definition (leadership / super_admin).
-- p_slots jsonb: [{"weekday":1,"start_time":"10:00","end_time":"11:30"}, ...]
-- Validated server-side: name required, ≥1 slot, weekday 0..6, valid
-- "HH:MM" times, end > start, no duplicate identical slots.
-- Returns {id, created}.
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_learning_group(
  p_id uuid,
  p_name text,
  p_description text,
  p_is_active boolean,
  p_slots jsonb,
  p_staff_leader_ids uuid[],
  p_student_leader_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff  uuid := public.current_staff_id();
  v_name   text := btrim(coalesce(p_name, ''));
  v_desc   text := nullif(btrim(coalesce(p_description, '')), '');
  v_gid    uuid := p_id;
  v_created boolean := false;
  v_slot   jsonb;
  v_elem   jsonb;
  v_wd     smallint;
  v_start  text;
  v_end    text;
  v_n      int;
  i        int;
  j        int;
  v_old_staff uuid[];
  v_old_students uuid[];
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_all_learning_groups(v_staff) then
    raise exception 'Only leadership or super_admin can manage learning groups'
      using errcode = '42501';
  end if;

  if v_name = '' or length(v_name) > 120 then
    raise exception 'שם הקבוצה נדרש (עד 120 תווים)' using errcode = '23514';
  end if;

  -- ---- slot validation ----
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    raise exception 'נדרש לפחות יום ושעת מפגש אחדים' using errcode = '23514';
  end if;
  v_n := jsonb_array_length(p_slots);
  if v_n < 1 or v_n > 30 then
    raise exception 'נדרש לפחות יום ושעת מפגש אחדים' using errcode = '23514';
  end if;

  for i in 0 .. v_n - 1 loop
    v_elem := p_slots -> i;
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'מפגש לא תקין' using errcode = '23514';
    end if;
    if v_elem ->> 'weekday' is null
       or v_elem ->> 'start_time' is null
       or v_elem ->> 'end_time' is null then
      raise exception 'מפגש לא תקין' using errcode = '23514';
    end if;
    v_wd    := (v_elem ->> 'weekday')::smallint;
    v_start := v_elem ->> 'start_time';
    v_end   := v_elem ->> 'end_time';
    if v_wd is null or v_wd < 0 or v_wd > 6 then
      raise exception 'יום בשבוע לא תקין' using errcode = '23514';
    end if;
    if v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'שעה לא תקינה (HH:MM)' using errcode = '23514';
    end if;
    if v_end::time <= v_start::time then
      raise exception 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' using errcode = '23514';
    end if;
  end loop;

  -- duplicate identical slots (same weekday + same start + same end)
  for i in 0 .. v_n - 1 loop
    for j in i + 1 .. v_n - 1 loop
      if (p_slots -> i ->> 'weekday')   = (p_slots -> j ->> 'weekday')
         and (p_slots -> i ->> 'start_time') = (p_slots -> j ->> 'start_time')
         and (p_slots -> i ->> 'end_time')   = (p_slots -> j ->> 'end_time') then
        raise exception 'אותו מפגש הוגדר פעמיים' using errcode = '23514';
      end if;
    end loop;
  end loop;

  -- ---- upsert the group row ----
  if v_gid is null then
    insert into public.learning_groups (name, description, is_active, created_by_staff_id)
    values (v_name, v_desc, coalesce(p_is_active, true), v_staff)
    returning id into v_gid;
    v_created := true;
  else
    update public.learning_groups
       set name = v_name,
           description = v_desc,
           is_active = coalesce(p_is_active, true)
     where id = v_gid;
    if not found then
      raise exception 'Learning group not found';
    end if;
  end if;

  -- ---- replace slots ----
  delete from public.learning_group_weekly_slots where learning_group_id = v_gid;
  insert into public.learning_group_weekly_slots (learning_group_id, weekday, start_time, end_time)
  select v_gid,
         (s ->> 'weekday')::smallint,
         (s ->> 'start_time')::time,
         (s ->> 'end_time')::time
    from jsonb_array_elements(p_slots) s;

  -- ---- leaders (audit only when the sets actually change) ----
  select coalesce(array_agg(staff_id order by staff_id), '{}') into v_old_staff
    from public.learning_group_staff_leaders where learning_group_id = v_gid;
  select coalesce(array_agg(student_id order by student_id), '{}') into v_old_students
    from public.learning_group_student_leaders where learning_group_id = v_gid;

  delete from public.learning_group_staff_leaders where learning_group_id = v_gid;
  if p_staff_leader_ids is not null then
    insert into public.learning_group_staff_leaders (learning_group_id, staff_id)
    select distinct v_gid, sid from unnest(p_staff_leader_ids) sid;
  end if;

  delete from public.learning_group_student_leaders where learning_group_id = v_gid;
  if p_student_leader_ids is not null then
    insert into public.learning_group_student_leaders (learning_group_id, student_id)
    select distinct v_gid, sid from unnest(p_student_leader_ids) sid;
  end if;

  -- ---- audit ----
  if v_created then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'learning_group_created', 'learning_group', v_gid,
            jsonb_build_object('name', v_name, 'slots', v_n));
  else
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'learning_group_updated', 'learning_group', v_gid,
            jsonb_build_object('name', v_name, 'is_active', coalesce(p_is_active, true), 'slots', v_n));
  end if;

  if (v_old_staff is distinct from coalesce(p_staff_leader_ids, '{}'))
     or (v_old_students is distinct from coalesce(p_student_leader_ids, '{}')) then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'learning_group_leaders_updated', 'learning_group', v_gid,
            jsonb_build_object(
              'staff_leaders', coalesce(p_staff_leader_ids, '{}'),
              'student_leaders', coalesce(p_student_leader_ids, '{}')));
  end if;

  return jsonb_build_object('id', v_gid, 'created', v_created);
end;
$$;

-- ---------------------------------------------------------------------------
-- membership add (staff leader of THAT group / leadership / super_admin).
-- Idempotent: an already-active membership is left untouched. A membership
-- added here is ALWAYS source='manual' — provenance that registration
-- resubmission must respect.
-- ---------------------------------------------------------------------------
create or replace function public.learning_group_add_member(p_group_id uuid, p_student_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_learning_group_membership(v_staff, p_group_id) then
    raise exception 'Only a leader of this learning group, leadership or super_admin can manage its members'
      using errcode = '42501';
  end if;
  if p_student_id is null or not exists (
    select 1 from public.students s where s.id = p_student_id and not s.is_archived
  ) then
    raise exception 'החניך/ה לא נמצא/ת' using errcode = '23514';
  end if;

  -- already active → no-op (also covers registration-sourced memberships)
  if exists (
    select 1 from public.learning_group_memberships m
     where m.learning_group_id = p_group_id
       and m.student_id = p_student_id
       and m.ended_at is null
  ) then
    return true;
  end if;

  insert into public.learning_group_memberships
    (learning_group_id, student_id, source, added_by_staff_id)
  values (p_group_id, p_student_id, 'manual', v_staff);

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'learning_group_member_added', 'learning_group', p_group_id,
          jsonb_build_object('student_id', p_student_id));

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- membership remove — soft end (ended_at); history preserved.
-- Never touches the student's home group (greenhouse_groups).
-- ---------------------------------------------------------------------------
create or replace function public.learning_group_remove_member(p_group_id uuid, p_student_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.staff_can_manage_learning_group_membership(v_staff, p_group_id) then
    raise exception 'Only a leader of this learning group, leadership or super_admin can manage its members'
      using errcode = '42501';
  end if;

  update public.learning_group_memberships
     set ended_at = now()
   where learning_group_id = p_group_id
     and student_id = p_student_id
     and ended_at is null;

  if found then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'learning_group_member_removed', 'learning_group', p_group_id,
            jsonb_build_object('student_id', p_student_id));
  end if;

  return true;
end;
$$;

-- ============================================================================
-- FUTURE DAILY-SCHEDULE QUERIES (designed to feed the future mobile UI —
-- no schedule UI is built in this phase)
-- ============================================================================

-- "Which learning groups run on weekday X?"
create or replace function public.learning_groups_on_weekday(p_weekday smallint)
returns table (
  learning_group_id    uuid,
  group_name           text,
  is_active            boolean,
  start_time           time,
  end_time             time,
  staff_leader_names   text[],
  student_leader_names text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.is_active, s.start_time, s.end_time,
         coalesce((
           select array_agg(p.full_name order by p.full_name)
             from public.learning_group_staff_leaders l
             join public.profiles p on p.id = l.staff_id
            where l.learning_group_id = g.id
         ), '{}'),
         coalesce((
           select array_agg(st.first_name || ' ' || st.last_name order by st.first_name)
             from public.learning_group_student_leaders l
             join public.students st on st.id = l.student_id
            where l.learning_group_id = g.id
         ), '{}')
    from public.learning_groups g
    join public.learning_group_weekly_slots s on s.learning_group_id = g.id
   where s.weekday = p_weekday
   order by g.name, s.start_time;
$$;

-- "Which learning groups does staff member X lead on weekday X?"
create or replace function public.staff_learning_groups_on_weekday(
  p_staff_id uuid,
  p_weekday smallint
)
returns table (
  learning_group_id uuid,
  group_name        text,
  start_time        time,
  end_time          time
)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, s.start_time, s.end_time
    from public.learning_groups g
    join public.learning_group_weekly_slots s on s.learning_group_id = g.id
   where s.weekday = p_weekday
     and exists (
       select 1 from public.learning_group_staff_leaders l
        where l.learning_group_id = g.id and l.staff_id = p_staff_id
     )
   order by s.start_time, g.name;
$$;

-- Attendance-ready roster primitive (attendance itself is NOT modeled here):
-- learning_group + calendar date + scheduled slot(s) + current membership
-- roster, in one query for a future attendance feature.
create or replace function public.learning_group_roster_on_date(
  p_group_id uuid,
  p_date date
)
returns table (
  slot_weekday smallint,
  start_time   time,
  end_time     time,
  student_id   uuid,
  first_name   text,
  last_name    text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.weekday, s.start_time, s.end_time,
         m.student_id, st.first_name, st.last_name
    from public.learning_group_weekly_slots s
    cross join public.learning_group_memberships m
    join public.students st on st.id = m.student_id
   where s.learning_group_id = p_group_id
     and m.learning_group_id = p_group_id
     and m.ended_at is null
     and s.weekday = extract(dow from p_date)::smallint -- 0=Sunday convention
   order by s.start_time, st.first_name, st.last_name;
$$;

-- ============================================================================
-- PUBLIC REGISTRATION RPCs (anon + authenticated execute; token-gated;
-- fail closed; expose ONLY minimal data — never emails, roles or auth ids)
-- ============================================================================

-- shared resolver: window row or NULL (hash lookup, not revoked, not deleted)
create or replace function public.lgreg_window_for_token(p_token text)
returns public.learning_group_registration_windows
language sql
stable
security definer
set search_path = public
as $$
  select w.*
    from public.learning_group_registration_windows w
   where w.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and w.is_revoked = false
     and w.deleted_at is null
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- overview: status + selectable learning groups WITH their weekly slots and
-- leader names. The slots drive the conflict-aware UI; the SERVER recomputes
-- conflicts canonically at submit time.
-- ---------------------------------------------------------------------------
create or replace function public.public_lgreg_overview(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.learning_group_registration_windows;
begin
  select * into w from public.lgreg_window_for_token(p_token);

  if w.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if now() < w.opens_at then
    return jsonb_build_object('status', 'not_open', 'title', w.title, 'opens_at', w.opens_at);
  end if;
  if now() > w.closes_at then
    return jsonb_build_object('status', 'closed', 'title', w.title, 'closes_at', w.closes_at);
  end if;

  return jsonb_build_object(
    'status', 'open',
    'title', w.title,
    'opens_at', w.opens_at,
    'closes_at', w.closes_at,
    'home_groups', (
      select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name), '[]'::jsonb)
      from public.greenhouse_groups g
    ),
    'learning_groups', (
      select coalesce(jsonb_agg(lg order by lg ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'id', g.id,
                 'name', g.name,
                 'description', g.description,
                 'slots', (
                   select coalesce(jsonb_agg(jsonb_build_object(
                            'weekday', s.weekday,
                            'start_time', to_char(s.start_time, 'HH24:MI'),
                            'end_time', to_char(s.end_time, 'HH24:MI'))
                            order by s.weekday, s.start_time), '[]'::jsonb)
                   from public.learning_group_weekly_slots s
                  where s.learning_group_id = g.id
                 ),
                 'staff_leader_names', coalesce((
                   select jsonb_agg(p.full_name order by p.full_name)
                     from public.learning_group_staff_leaders l
                     join public.profiles p on p.id = l.staff_id
                    where l.learning_group_id = g.id
                 ), '[]'::jsonb),
                 'student_leader_names', coalesce((
                   select jsonb_agg(st.first_name || ' ' || st.last_name order by st.first_name)
                     from public.learning_group_student_leaders l
                     join public.students st on st.id = l.student_id
                    where l.learning_group_id = g.id
                 ), '[]'::jsonb)
               ) as lg
          from public.learning_groups g
          join public.learning_group_registration_window_groups wg
            on wg.learning_group_id = g.id
         where wg.registration_window_id = w.id
           and g.is_active
      ) t
    )
  );
exception
  when others then
    return jsonb_build_object('status', 'error');
end;
$$;

-- ---------------------------------------------------------------------------
-- students of a chosen home group (only while open; active students only)
-- ---------------------------------------------------------------------------
create or replace function public.public_lgreg_students(p_token text, p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.learning_group_registration_windows;
begin
  w := public.lgreg_window_for_token(p_token);
  if w.id is null or now() < w.opens_at or now() > w.closes_at then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'first_name', s.first_name, 'last_name', s.last_name)
           order by s.first_name, s.last_name)
    from public.students s
   where s.group_id = p_group_id
     and s.is_archived = false
  ), '[]'::jsonb);
exception
  when others then
    return '[]'::jsonb;
end;
$$;

-- ---------------------------------------------------------------------------
-- the student's CURRENT selection in THIS window (for edit/resubmit).
-- Minimal data: selected group ids only.
-- ---------------------------------------------------------------------------
create or replace function public.public_lgreg_registration(p_token text, p_student_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.learning_group_registration_windows;
  r public.learning_group_registrations;
begin
  w := public.lgreg_window_for_token(p_token);
  if w.id is null or now() < w.opens_at or now() > w.closes_at then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select * into r
    from public.learning_group_registrations
   where registration_window_id = w.id
     and student_id = p_student_id;

  if r.id is null then
    return jsonb_build_object('status', 'none');
  end if;
  return jsonb_build_object('status', 'ok', 'selected', to_jsonb(r.selected_group_ids));
exception
  when others then
    return jsonb_build_object('status', 'unavailable');
end;
$$;

-- ---------------------------------------------------------------------------
-- SUBMIT — the canonical server-side gate.
--   1. token + window open
--   2. student exists, active, and belongs to the chosen home group
--   3. every selected group is selectable in THIS window and active
--   4. RECOMPUTE conflicts from canonical DB schedules (weekly_slots_overlap);
--      NEVER trust browser-supplied schedule data. Touching slots pass.
--   5. upsert the registration (unique window+student → edit/resubmit)
--   6. transactionally synchronize memberships created by THIS registration:
--        end deselected 'registration'-sourced memberships of THIS registration
--        add newly selected groups
--        NEVER touch 'manual' memberships or other registrations' memberships
-- ---------------------------------------------------------------------------
create or replace function public.public_lgreg_submit(
  p_token text,
  p_student_id uuid,
  p_home_group_id uuid,
  p_selected_group_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  w public.learning_group_registration_windows;
  v_student public.students;
  v_reg public.learning_group_registrations;
  v_selected uuid[];
  v_slot_a record;
  v_slot_b record;
  v_conflict text;
begin
  w := public.lgreg_window_for_token(p_token);
  if w.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if now() < w.opens_at then
    return jsonb_build_object('status', 'not_open');
  end if;
  if now() > w.closes_at then
    return jsonb_build_object('status', 'closed');
  end if;

  select * into v_student from public.students where id = p_student_id;
  if v_student.id is null or v_student.is_archived or v_student.group_id is null
     or v_student.group_id <> p_home_group_id then
    return jsonb_build_object('status', 'error', 'message', 'בחירת הקבוצה או החניך/ה אינה תקינה');
  end if;

  -- dedupe + drop nulls; must be non-empty
  select coalesce(array_agg(distinct sid), '{}') into v_selected
    from unnest(coalesce(p_selected_group_ids, '{}')) sid
   where sid is not null;
  if coalesce(array_length(v_selected, 1), 0) = 0 then
    return jsonb_build_object('status', 'error', 'message', 'בחרו לפחות קבוצת למידה אחת');
  end if;

  -- every selected group must be selectable in THIS window AND active
  if exists (
    select 1 from unnest(v_selected) sid
     where not exists (
       select 1
         from public.learning_group_registration_window_groups wg
         join public.learning_groups g on g.id = wg.learning_group_id
        where wg.registration_window_id = w.id
          and wg.learning_group_id = sid
          and g.is_active
     )
  ) then
    return jsonb_build_object('status', 'error', 'message', 'אחת מקבוצות הלמידה אינה זמינה להרשמה');
  end if;

  -- canonical conflict recomputation from DB schedules (multi-slot safe):
  -- compare ALL slot combinations of every PAIR of selected groups
  for v_slot_a in
    select g.id as group_id, g.name as group_name,
           s.weekday, s.start_time, s.end_time
      from public.learning_group_weekly_slots s
      join public.learning_groups g on g.id = s.learning_group_id
     where s.learning_group_id in (select unnest(v_selected))
  loop
    for v_slot_b in
      select g.id as group_id, g.name as group_name,
             s.weekday, s.start_time, s.end_time
        from public.learning_group_weekly_slots s
        join public.learning_groups g on g.id = s.learning_group_id
       where s.learning_group_id in (select unnest(v_selected))
         and g.id <> v_slot_a.group_id
         and (g.id > v_slot_a.group_id or v_slot_a.weekday <> s.weekday
              or v_slot_a.start_time < s.start_time)
    loop
      if public.weekly_slots_overlap(
           v_slot_a.weekday, v_slot_a.start_time, v_slot_a.end_time,
           v_slot_b.weekday, v_slot_b.start_time, v_slot_b.end_time) then
        v_conflict := format('הבחירה "%s" חופפת עם "%s" (יום %s %s–%s). ניתן לבחור רק אחת מהן.',
          v_slot_a.group_name, v_slot_b.group_name,
          public.weekday_name_he(v_slot_a.weekday),
          to_char(v_slot_a.start_time, 'HH24:MI'),
          to_char(v_slot_a.end_time, 'HH24:MI'));
        return jsonb_build_object('status', 'error', 'message', v_conflict);
      end if;
    end loop;
  end loop;

  -- upsert the registration (one per window+student; resubmission = edit)
  insert into public.learning_group_registrations
    (registration_window_id, student_id, home_group_id, selected_group_ids)
  values
    (w.id, p_student_id, p_home_group_id, v_selected)
  on conflict (registration_window_id, student_id) do update
    set home_group_id      = excluded.home_group_id,
        selected_group_ids = excluded.selected_group_ids,
        updated_at         = now();

  select * into v_reg
    from public.learning_group_registrations
   where registration_window_id = w.id
     and student_id = p_student_id;

  -- ---- transactional membership synchronization (THIS registration only) ----
  -- end memberships created by THIS registration that were deselected
  update public.learning_group_memberships m
     set ended_at = now()
   where m.registration_id = v_reg.id
     and m.ended_at is null
     and not (m.learning_group_id in (select unnest(v_selected)));

  -- add newly selected groups; manual memberships (any group) are untouched
  insert into public.learning_group_memberships
    (learning_group_id, student_id, source, registration_id)
  select sid, p_student_id, 'registration', v_reg.id
    from unnest(v_selected) sid
   where not exists (
     select 1 from public.learning_group_memberships m
      where m.learning_group_id = sid
        and m.student_id = p_student_id
        and m.ended_at is null
   );

  return jsonb_build_object('status', 'ok');
exception
  when others then
    return jsonb_build_object('status', 'error', 'message', 'השליחה נכשלה. נסו שוב.');
end;
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.learning_groups                          enable row level security;
alter table public.learning_group_weekly_slots              enable row level security;
alter table public.learning_group_staff_leaders             enable row level security;
alter table public.learning_group_student_leaders           enable row level security;
alter table public.learning_group_memberships               enable row level security;
alter table public.learning_group_registration_windows      enable row level security;
alter table public.learning_group_registration_window_groups enable row level security;
alter table public.learning_group_registrations             enable row level security;

-- org-structure-like tables: readable by all staff, NO client writes
create policy "learning_groups_select_staff" on public.learning_groups
  for select to authenticated using (public.is_authorized_staff());

create policy "lg_slots_select_staff" on public.learning_group_weekly_slots
  for select to authenticated using (public.is_authorized_staff());

create policy "lg_staff_leaders_select_staff" on public.learning_group_staff_leaders
  for select to authenticated using (public.is_authorized_staff());

create policy "lg_student_leaders_select_staff" on public.learning_group_student_leaders
  for select to authenticated using (public.is_authorized_staff());

create policy "lg_memberships_select_staff" on public.learning_group_memberships
  for select to authenticated using (public.is_authorized_staff());

-- registration management data: leadership / super_admin only
create policy "lgreg_windows_select_admin" on public.learning_group_registration_windows
  for select to authenticated
  using (
    public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'leadership')
  );

create policy "lgreg_window_groups_select_admin" on public.learning_group_registration_window_groups
  for select to authenticated
  using (
    public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'leadership')
  );

create policy "lgreg_registrations_select_admin" on public.learning_group_registrations
  for select to authenticated
  using (
    public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'leadership')
  );

-- anonymous users get NO table access: the public flow runs exclusively
-- through the token-gated security-definer RPCs above.

-- ============================================================================
-- Grants
-- ============================================================================
grant select on
  public.learning_groups,
  public.learning_group_weekly_slots,
  public.learning_group_staff_leaders,
  public.learning_group_student_leaders,
  public.learning_group_memberships
  to authenticated;

-- RLS narrows these to leadership/super_admin
grant select on
  public.learning_group_registration_windows,
  public.learning_group_registration_window_groups,
  public.learning_group_registrations
  to authenticated;

grant all on
  public.learning_groups,
  public.learning_group_weekly_slots,
  public.learning_group_staff_leaders,
  public.learning_group_student_leaders,
  public.learning_group_memberships,
  public.learning_group_registration_windows,
  public.learning_group_registration_window_groups,
  public.learning_group_registrations
  to service_role;

-- shared primitives: available to authenticated + service_role (future phases)
revoke all on function public.weekly_slots_overlap(smallint, time, time, smallint, time, time) from public, anon;
revoke all on function public.weekly_slot_sets_overlap(jsonb, jsonb)                        from public, anon;
revoke all on function public.weekday_name_he(smallint)                                     from public, anon;
grant execute on function public.weekly_slots_overlap(smallint, time, time, smallint, time, time) to authenticated, service_role;
grant execute on function public.weekly_slot_sets_overlap(jsonb, jsonb)                           to authenticated, service_role;
grant execute on function public.weekday_name_he(smallint)                                        to authenticated, service_role;

-- staff management RPCs (authorization inside)
revoke all on function public.admin_upsert_learning_group(uuid, text, text, boolean, jsonb, uuid[], uuid[]) from public, anon;
revoke all on function public.learning_group_add_member(uuid, uuid)    from public, anon;
revoke all on function public.learning_group_remove_member(uuid, uuid) from public, anon;
grant execute on function public.admin_upsert_learning_group(uuid, text, text, boolean, jsonb, uuid[], uuid[]) to authenticated;
grant execute on function public.learning_group_add_member(uuid, uuid)    to authenticated;
grant execute on function public.learning_group_remove_member(uuid, uuid) to authenticated;

-- future-schedule queries (authenticated staff)
revoke all on function public.learning_groups_on_weekday(smallint)              from public, anon;
revoke all on function public.staff_learning_groups_on_weekday(uuid, smallint)  from public, anon;
revoke all on function public.learning_group_roster_on_date(uuid, date)         from public, anon;
grant execute on function public.learning_groups_on_weekday(smallint)             to authenticated, service_role;
grant execute on function public.staff_learning_groups_on_weekday(uuid, smallint) to authenticated, service_role;
grant execute on function public.learning_group_roster_on_date(uuid, date)        to authenticated, service_role;

-- public token-gated RPCs: anon + authenticated (staff may open public links)
revoke all on function public.lgreg_window_for_token(text)              from public, anon, authenticated;
revoke all on function public.public_lgreg_overview(text)               from public, anon, authenticated;
revoke all on function public.public_lgreg_students(text, uuid)         from public, anon, authenticated;
revoke all on function public.public_lgreg_registration(text, uuid)     from public, anon, authenticated;
revoke all on function public.public_lgreg_submit(text, uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.public_lgreg_overview(text)               to anon, authenticated;
grant execute on function public.public_lgreg_students(text, uuid)         to anon, authenticated;
grant execute on function public.public_lgreg_registration(text, uuid)     to anon, authenticated;
grant execute on function public.public_lgreg_submit(text, uuid, uuid, uuid[]) to anon, authenticated;
