-- ============================================================================
-- Major heads see their major's students on Home (migration 20260923000007).
--   supabase db reset && psql -f supabase/tests/major_head_home_tests.sql
--
-- Canonical relationship: major_heads -> major -> students of that major
-- (public.is_major_head_for_student: project major when a project exists,
-- otherwise students.major_id). Roles (leadership / super_admin) grant
-- nothing to home_major_student_ids().
--
-- Seed: רוני (staff + major_head) heads מגמת תקשורת; ליאת (leadership +
-- major_head) heads מגמת ביוטכנולוגיה; רונן is super_admin and heads nothing.
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

\echo '--- starting major-head Home test suite ---'

create or replace function pg_temp.act_as(p_email text)
returns void language plpgsql as $$
declare v_uid uuid;
begin
  select auth_user_id into v_uid from public.profiles where email = p_email;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
end;
$$;

create or replace function pg_temp.staff(p_email text)
returns uuid language sql as $$
  select id from public.profiles where email = p_email;
$$;

-- independent reference: non-archived students of every major the staff
-- member heads (project major first, else the student's own major)
create or replace function pg_temp.expected(p_staff uuid)
returns table (student_id uuid) language sql as $$
  select s.id
    from public.students s
    left join public.student_projects sp on sp.student_id = s.id
   where not s.is_archived
     and (case when sp.id is not null then sp.major_id else s.major_id end)
         in (select mh.major_id from public.major_heads mh where mh.staff_id = p_staff);
$$;

-- set equality between the RPC and the reference (and no duplicates)
create or replace function pg_temp.assert_home_major(p_email text, p_label text)
returns int language plpgsql as $$
declare
  v_staff uuid := pg_temp.staff(p_email);
  v_got int; v_distinct int; v_exp int; v_diff int;
begin
  perform pg_temp.act_as(p_email);
  select count(*), count(distinct h.student_id) into v_got, v_distinct
    from public.home_major_student_ids() h;
  select count(*) into v_exp from pg_temp.expected(v_staff);
  select count(*) into v_diff from (
    (select h.student_id from public.home_major_student_ids() h
     except select e.student_id from pg_temp.expected(v_staff) e)
    union all
    (select e.student_id from pg_temp.expected(v_staff) e
     except select h.student_id from public.home_major_student_ids() h)
  ) d;
  if v_got <> v_distinct then
    raise exception 'FAIL: % — duplicate students (% rows, % distinct)', p_label, v_got, v_distinct;
  end if;
  if v_diff <> 0 or v_got <> v_exp then
    raise exception 'FAIL: % — got % students, expected %', p_label, v_got, v_exp;
  end if;
  return v_got;
end;
$$;

-- ============================================================================
-- MH1: a major head with ONE major (not privileged) sees all and only that
--      major's students — on the id list AND in dashboard_rows (root cause:
--      the old dashboard scope missed students whose major is students.major_id)
-- ============================================================================
begin;
do $$
declare
  v_n int;
  v_rows int;
begin
  v_n := pg_temp.assert_home_major('roni@chamama.example', 'MH1 roni/תקשורת');
  if v_n < 5 then raise exception 'FAIL: MH1 expected the seeded תקשורת students, got %', v_n; end if;
  if exists (
    select 1 from public.home_major_student_ids() h
      join public.students s on s.id = h.student_id
     where s.major_id is distinct from '33333333-3333-3333-3333-333333333301'
  ) then raise exception 'FAIL: MH1 a non-תקשורת student leaked in'; end if;

  select count(*) into v_rows
    from public.dashboard_rows() d
    join public.home_major_student_ids() h on h.student_id = d.student_id
   where d.in_my_majors;
  if v_rows <> v_n then
    raise exception 'FAIL: MH1 dashboard_rows has % of % major students', v_rows, v_n;
  end if;
  raise notice 'PASS: single-major head sees all % students of the major (ids + dashboard rows)', v_n;
end $$;
rollback;

-- ============================================================================
-- MH2: a major head with SEVERAL majors gets the union, no duplicates
-- ============================================================================
begin;
insert into public.major_heads (major_id, staff_id)
values ('33333333-3333-3333-3333-333333333303', pg_temp.staff('roni@chamama.example'));
do $$
declare v_n int;
begin
  v_n := pg_temp.assert_home_major('roni@chamama.example', 'MH2 roni/תקשורת+מדעי המחשב');
  if v_n <> (select count(*) from public.students
              where not is_archived
                and major_id in ('33333333-3333-3333-3333-333333333301',
                                 '33333333-3333-3333-3333-333333333303')) then
    raise exception 'FAIL: MH2 union size %', v_n;
  end if;
  raise notice 'PASS: multi-major head sees the distinct union (% students)', v_n;
end $$;
rollback;

-- ============================================================================
-- MH3: canonical precedence — a project major overrides students.major_id
-- ============================================================================
begin;
insert into public.student_projects (student_id, major_id)
values ('44444444-4444-4444-4444-444444444401', '33333333-3333-3333-3333-333333333302');
do $$
begin
  perform pg_temp.assert_home_major('roni@chamama.example', 'MH3 roni');
  if exists (select 1 from public.home_major_student_ids()
              where student_id = '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: MH3 project major must win over students.major_id';
  end if;
  perform pg_temp.assert_home_major('liat@chamama.example', 'MH3 liat');
  if not exists (select 1 from public.home_major_student_ids()
                  where student_id = '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: MH3 the project major''s head must see the student';
  end if;
  raise notice 'PASS: project major takes precedence (canonical is_major_head_for_student)';
end $$;
rollback;

-- ============================================================================
-- MH4: not a major head -> nothing (mentor, master, plain staff)
-- ============================================================================
begin;
do $$
declare e text;
begin
  foreach e in array array['michal@chamama.example', 'naama@chamama.example',
                           'tom@chamama.example', 'itay@chamama.example'] loop
    perform pg_temp.act_as(e);
    if exists (select 1 from public.home_major_student_ids()) then
      raise exception 'FAIL: MH4 % is not a major head but got major students', e;
    end if;
  end loop;
  raise notice 'PASS: non-major-heads get no major students';
end $$;
rollback;

-- ============================================================================
-- MH5: super_admin / leadership status alone grants nothing; the Tal /
--      High-Tech equivalent (super_admin who heads a major) sees exactly it
-- ============================================================================
begin;
do $$
begin
  perform pg_temp.act_as('ronen@chamama.example');
  if exists (select 1 from public.home_major_student_ids()) then
    raise exception 'FAIL: MH5 super_admin (no major) got major students';
  end if;
  -- the broad dashboard still returns every student — Home must not use it
  if (select count(*) from public.dashboard_rows()) < 10 then
    raise exception 'FAIL: MH5 fixture — super_admin dashboard should be broad';
  end if;
  perform pg_temp.assert_home_major('liat@chamama.example', 'MH5 leadership+major head');
  if exists (
    select 1 from public.home_major_student_ids() h
      join public.students s on s.id = h.student_id
     where s.major_id is distinct from '33333333-3333-3333-3333-333333333302'
  ) then raise exception 'FAIL: MH5 leadership widened the major set'; end if;
  raise notice 'PASS: super_admin/leadership roles alone create no major-student access';
end $$;
insert into public.major_heads (major_id, staff_id)
values ('33333333-3333-3333-3333-333333333303', pg_temp.staff('ronen@chamama.example'));
do $$
declare v_n int; v_dash int;
begin
  v_n := pg_temp.assert_home_major('ronen@chamama.example', 'MH5 super_admin + head of מדעי המחשב');
  if v_n <> (select count(*) from public.students
              where not is_archived and major_id = '33333333-3333-3333-3333-333333333303') then
    raise exception 'FAIL: MH5 Tal-equivalent got % students', v_n;
  end if;
  select count(*) into v_dash from public.dashboard_rows() d
    join public.home_major_student_ids() h on h.student_id = d.student_id;
  if v_dash <> v_n then raise exception 'FAIL: MH5 dashboard rows missing (% of %)', v_dash, v_n; end if;
  raise notice 'PASS: super_admin who heads a major (Tal/High-Tech equivalent) sees every student of it (%)', v_n;
end $$;
rollback;

-- ============================================================================
-- MH6: View-As uses the SIMULATED person's relationships
-- ============================================================================
begin;
-- the real super_admin heads a major too — it must not leak into View-As
insert into public.major_heads (major_id, staff_id)
values ('33333333-3333-3333-3333-333333333303', pg_temp.staff('ronen@chamama.example'));
do $$
declare
  v_roni uuid := pg_temp.staff('roni@chamama.example');
  v_got int; v_exp int; v_diff int;
begin
  perform pg_temp.act_as('ronen@chamama.example');
  select count(*) into v_got from public.dashboard_rows_view_as(v_roni, 'major_head');
  select count(*) into v_exp from pg_temp.expected(v_roni);
  select count(*) into v_diff from (
    select student_id from public.dashboard_rows_view_as(v_roni, 'major_head')
    except select student_id from pg_temp.expected(v_roni)) d;
  if v_got <> v_exp or v_diff <> 0 then
    raise exception 'FAIL: MH6 View-As roni/major_head got %, expected %', v_got, v_exp;
  end if;

  -- not a major head: the major_head context yields nothing
  if exists (select 1 from public.dashboard_rows_view_as(pg_temp.staff('tom@chamama.example'), 'major_head'))
     or exists (select 1 from public.dashboard_rows_view_as(pg_temp.staff('michal@chamama.example'), 'major_head')) then
    raise exception 'FAIL: MH6 View-As of a non-major-head returned major students';
  end if;
  -- simulating a mentor shows the mentor's students only, never the real
  -- super_admin's major
  if exists (
    select 1 from public.dashboard_rows_view_as(pg_temp.staff('michal@chamama.example'), 'mentor') d
     where not public.is_student_mentor(pg_temp.staff('michal@chamama.example'), d.student_id)
  ) then raise exception 'FAIL: MH6 View-As mentor inherited other students'; end if;

  -- View-As remains super_admin-only
  perform pg_temp.act_as('liat@chamama.example');
  if exists (select 1 from public.dashboard_rows_view_as(v_roni, 'major_head')) then
    raise exception 'FAIL: MH6 non-super_admin used View-As';
  end if;
  raise notice 'PASS: View-As uses the simulated person''s major-head relationships only (% students)', v_got;
end $$;
rollback;

-- ============================================================================
-- MH7: archived students excluded; anon / signed-out / deactivated get nothing
-- ============================================================================
begin;
update public.students set is_archived = true
 where id = '44444444-4444-4444-4444-444444444403';
do $$
begin
  perform pg_temp.assert_home_major('roni@chamama.example', 'MH7 archived');
  if exists (select 1 from public.home_major_student_ids()
              where student_id = '44444444-4444-4444-4444-444444444403') then
    raise exception 'FAIL: MH7 archived student listed';
  end if;
  if has_function_privilege('anon', 'public.home_major_student_ids()', 'execute') then
    raise exception 'FAIL: MH7 anon can execute home_major_student_ids';
  end if;
  if not has_function_privilege('authenticated', 'public.home_major_student_ids()', 'execute') then
    raise exception 'FAIL: MH7 authenticated cannot execute home_major_student_ids';
  end if;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.home_major_student_ids()) then
    raise exception 'FAIL: MH7 signed-out caller got students';
  end if;
  raise notice 'PASS: archived excluded; anon/signed-out get nothing';
end $$;
update public.profiles set is_active = false where email = 'roni@chamama.example';
do $$
begin
  perform pg_temp.act_as('roni@chamama.example');
  if exists (select 1 from public.home_major_student_ids()) then
    raise exception 'FAIL: MH7 deactivated major head still gets students';
  end if;
  raise notice 'PASS: a deactivated major head gets nothing';
end $$;
rollback;

\echo '--- major-head Home test suite finished ---'
