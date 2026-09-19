-- ============================================================================
-- Migration 20260916000001: PROJECT INTAKE / MASTER REQUEST
--
-- Part A of the projects+meetings phase.
--
-- * student_projects   — the student's ONE current project (unique student_id):
--                        declared intent + project major. Existing exceptional
--                        multiple master_assignments are untouched.
-- * intake_windows     — time-limited public intake links (token stored as
--                        SHA-256 hash; plaintext shown once at creation).
-- * intake_submissions — one current submission per (intake, student),
--                        idempotently updated while the window is open.
-- * requested master is a REQUEST only — assignment happens explicitly by a
--   project coordinator / super_admin through coordinator_set_master().
-- * major-head authorization becomes project-major-aware: once a student has
--   a current project, the PROJECT major governs major-head access (a
--   project with no major — "לא במגמה" — grants no project-based major-head
--   access); students without a project keep the legacy students.major_id
--   behavior.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- student's current project (one per student)
-- ---------------------------------------------------------------------------
create table public.student_projects (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null unique references public.students (id) on delete cascade,
  intent_text  text,
  major_id     uuid references public.majors (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- intake windows (public links)
-- ---------------------------------------------------------------------------
create table public.intake_windows (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null check (length(btrim(title)) between 1 and 120),
  token_hash          text not null unique, -- sha256 hex of the public token
  opens_at            timestamptz not null,
  closes_at           timestamptz not null,
  is_revoked          boolean not null default false,
  created_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint intake_window_times_valid check (opens_at < closes_at)
);

-- ---------------------------------------------------------------------------
-- intake submissions (one current submission per intake + student)
-- ---------------------------------------------------------------------------
create table public.intake_submissions (
  id                        uuid primary key default gen_random_uuid(),
  intake_id                 uuid not null references public.intake_windows (id) on delete cascade,
  student_id                uuid not null references public.students (id) on delete cascade,
  intent_text               text not null check (length(btrim(intent_text)) between 1 and 500),
  major_id                  uuid references public.majors (id) on delete set null, -- NULL = לא במגמה
  requested_master_staff_id uuid not null references public.profiles (id),
  assigned_master_staff_id  uuid references public.profiles (id),
  assigned_by_staff_id      uuid references public.profiles (id),
  assigned_at               timestamptz,
  submitted_at              timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (intake_id, student_id)
);

create index idx_intake_submissions_intake on public.intake_submissions (intake_id);
create index idx_intake_submissions_student on public.intake_submissions (student_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance for the new tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['student_projects','intake_windows','intake_submissions']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- project-major-aware major-head authorization
-- (once a current project exists, the PROJECT major governs; "לא במגמה"
--  projects grant no project-based major-head access; students without a
--  project keep the legacy students.major_id behavior)
-- ---------------------------------------------------------------------------
create or replace function public.is_major_head_for_student(
  p_staff_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.student_projects sp where sp.student_id = p_student_id) then
      exists (
        select 1
          from public.student_projects sp
          join public.major_heads mh on mh.major_id = sp.major_id
       where sp.student_id = p_student_id
         and mh.staff_id = p_staff_id
      )
    else
      exists (
        select 1
          from public.students s
          join public.major_heads mh on mh.major_id = s.major_id
       where s.id = p_student_id
         and mh.staff_id = p_staff_id
      )
  end;
$$;

-- ---------------------------------------------------------------------------
-- PUBLIC INTAKE RPCS (callable by anon; token-gated; fail closed; expose
-- only the minimum data needed by the form protocol — never emails, roles
-- or auth identities)
-- ---------------------------------------------------------------------------
create or replace function public.intake_window_for_token(p_token text)
returns public.intake_windows
language sql
stable
security definer
set search_path = public
as $$
  -- built-in sha256() (PG11+): avoids a pgcrypto schema dependency
  -- (hosted Supabase installs pgcrypto into `extensions`, not `public`)
  select w.*
    from public.intake_windows w
   where w.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and w.is_revoked = false
   limit 1;
$$;

-- window state + the list of groups (only while open)
create or replace function public.public_intake_overview(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when w.id is null then jsonb_build_object('status', 'invalid')
    when now() < w.opens_at then jsonb_build_object(
      'status', 'not_open', 'title', w.title, 'opens_at', w.opens_at)
    when now() > w.closes_at then jsonb_build_object(
      'status', 'closed', 'title', w.title, 'closes_at', w.closes_at)
    else jsonb_build_object(
      'status', 'open', 'title', w.title, 'opens_at', w.opens_at, 'closes_at', w.closes_at,
      'groups', (
        select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name), '[]'::jsonb)
        from public.greenhouse_groups g
      )
    )
  end
  from public.intake_window_for_token(p_token) w;
$$;

-- students of a chosen group (only while open; active students only)
create or replace function public.public_intake_students(p_token text, p_group_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when w.id is null or now() < w.opens_at or now() > w.closes_at then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'first_name', s.first_name, 'last_name', s.last_name)
             order by s.first_name, s.last_name)
      from public.students s
     where s.group_id = p_group_id
       and s.is_archived = false
    ), '[]'::jsonb)
  end
  from public.intake_window_for_token(p_token) w;
$$;

-- majors for the "does the project belong to a major?" question
create or replace function public.public_intake_majors(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when w.id is null or now() < w.opens_at or now() > w.closes_at then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.name)
      from public.majors m
    ), '[]'::jsonb)
  end
  from public.intake_window_for_token(p_token) w;
$$;

-- requested-master choices: ACTIVE staff, name only
create or replace function public.public_intake_masters(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when w.id is null or now() < w.opens_at or now() > w.closes_at then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, '')) order by coalesce(p.full_name, ''))
      from public.profiles p
     where p.is_active
    ), '[]'::jsonb)
  end
  from public.intake_window_for_token(p_token) w;
$$;

-- submit (idempotent upsert per intake+student; updates while open; server
-- revalidates group membership, major existence and master activity)
create or replace function public.public_intake_submit(
  p_token text,
  p_student_id uuid,
  p_group_id uuid,
  p_intent text,
  p_major_id uuid,
  p_master_staff_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  w public.intake_windows;
  v_student public.students;
  v_intent text := btrim(coalesce(p_intent, ''));
begin
  w := public.intake_window_for_token(p_token);
  if w.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if now() < w.opens_at then
    return jsonb_build_object('status', 'not_open');
  end if;
  if now() > w.closes_at then
    return jsonb_build_object('status', 'closed');
  end if;

  if v_intent = '' or length(v_intent) > 500 then
    return jsonb_build_object('status', 'error', 'message', 'נסחו משפט אחד באורך של עד 500 תווים');
  end if;

  -- revalidate the student: exists, active, and really in the chosen group
  select * into v_student from public.students where id = p_student_id;
  if v_student.id is null or v_student.is_archived or v_student.group_id is null
     or v_student.group_id <> p_group_id then
    return jsonb_build_object('status', 'error', 'message', 'בחירת הקבוצה או החניך/ה אינה תקינה');
  end if;

  -- revalidate major (null = לא במגמה)
  if p_major_id is not null and not exists (select 1 from public.majors m where m.id = p_major_id) then
    return jsonb_build_object('status', 'error', 'message', 'המגמה שנבחרה אינה קיימת');
  end if;

  -- revalidate requested master: active staff only
  if p_master_staff_id is null or not exists (
    select 1 from public.profiles p where p.id = p_master_staff_id and p.is_active
  ) then
    return jsonb_build_object('status', 'error', 'message', 'המאסטר/ית המבוקש/ת אינו/ה זמין/ה');
  end if;

  -- idempotent: one current submission per intake+student
  insert into public.intake_submissions
    (intake_id, student_id, intent_text, major_id, requested_master_staff_id)
  values
    (w.id, p_student_id, v_intent, p_major_id, p_master_staff_id)
  on conflict (intake_id, student_id) do update
    set intent_text               = excluded.intent_text,
        major_id                  = excluded.major_id,
        requested_master_staff_id = excluded.requested_master_staff_id,
        updated_at                = now();

  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- Coordinator / super_admin: finalize the assigned master. Transactional.
--   * upserts the student's CURRENT project (intent + major from submission)
--   * upserts the canonical master_assignments row (existing exceptional
--     multiple masters are preserved — nothing is removed)
--   * stamps the submission with the assignment
--   * audits the decision
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
  v_is_admin boolean;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  v_is_admin := public.staff_has_role(v_staff, 'super_admin')
                or public.staff_has_role(v_staff, 'project_coordinator');
  if not v_is_admin then
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

  -- canonical master assignment (additive; exceptional multiples preserved)
  insert into public.master_assignments (student_id, staff_id)
  values (v_sub.student_id, p_master_staff_id)
  on conflict (student_id, staff_id) do nothing;

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
            'requested_master_staff_id', v_sub.requested_master_staff_id
          ));

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.student_projects  enable row level security;
alter table public.intake_windows    enable row level security;
alter table public.intake_submissions enable row level security;

-- staff can read the current project of students (dashboards / student page);
-- writes happen only through the coordinator RPC / service role
create policy "student_projects_select_staff"
  on public.student_projects
  for select to authenticated
  using (public.is_authorized_staff());

-- intake management: project coordinator or super_admin
create policy "intake_windows_select_coordinator"
  on public.intake_windows
  for select to authenticated
  using (
    public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
  );

create policy "intake_submissions_select_coordinator"
  on public.intake_submissions
  for select to authenticated
  using (
    public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
  );

-- anonymous users get NO table access: the public flow runs exclusively
-- through the token-gated security-definer RPCs above.

-- ---------------------------------------------------------------------------
-- grants (explicit + portable; hosted Supabase default privileges would
-- cover these too, but we state them for a least-privilege audit)
-- ---------------------------------------------------------------------------
grant select on public.student_projects   to authenticated;
grant select on public.intake_windows     to authenticated;
grant select on public.intake_submissions to authenticated;
grant all on public.student_projects   to service_role;
grant all on public.intake_windows     to service_role;
grant all on public.intake_submissions to service_role;

revoke all on function public.intake_window_for_token(text)          from public, anon, authenticated;
revoke all on function public.public_intake_overview(text)           from public, anon, authenticated;
revoke all on function public.public_intake_students(text, uuid)     from public, anon, authenticated;
revoke all on function public.public_intake_majors(text)             from public, anon, authenticated;
revoke all on function public.public_intake_masters(text)            from public, anon, authenticated;
revoke all on function public.public_intake_submit(text, uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.coordinator_set_master(uuid, uuid)     from public, anon, authenticated;

grant execute on function public.intake_window_for_token(text)       to service_role;
grant execute on function public.public_intake_overview(text)        to anon;
grant execute on function public.public_intake_students(text, uuid)  to anon;
grant execute on function public.public_intake_majors(text)          to anon;
grant execute on function public.public_intake_masters(text)         to anon;
grant execute on function public.public_intake_submit(text, uuid, uuid, text, uuid, uuid) to anon;
grant execute on function public.coordinator_set_master(uuid, uuid)  to authenticated;
