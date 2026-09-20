-- ============================================================================
-- Dashboard major-fallback behavioral tests (migration 20260921000003)
--   run: psql "$SUPABASE_DB_URL" -f supabase/tests/dashboard_major_tests.sql
--   (local: supabase db reset first — migrations + seed must be applied)
-- Covers the canonical display logic for project_major_name:
--   1. current student project major wins
--   2. fallback to students.major_id when no project major exists
--   3. NULL when neither exists
-- Every case runs in a transaction and rolls back.
-- ============================================================================

\set ronen '11111111-1111-1111-1111-111111111101'
\set major_project 'd0000000-0000-0000-0000-000000000001'
\set major_static 'd0000000-0000-0000-0000-000000000002'

begin;

-- super_admin identity for the broad dashboard view
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where id = :'ronen';

-- majors
insert into public.majors (id, name) values
  (:'major_project', 'מגמת פרויקט בדיקה'),
  (:'major_static',  'מגמה סטטית בדיקה')
on conflict (id) do update set name = excluded.name;

-- case 1: student WITH a current project major
insert into public.students (id, first_name, last_name, major_id, is_archived)
values ('e0000000-0000-0000-0000-000000000001', 'בדיקה', 'פרויקט־מגמה', :'major_static', false)
on conflict (id) do nothing;
insert into public.student_projects (student_id, major_id, intent_text)
values ('e0000000-0000-0000-0000-000000000001', :'major_project', 'בדיקה')
on conflict (student_id) do update set major_id = excluded.major_id;

-- case 2: student with ONLY students.major_id (no project)
insert into public.students (id, first_name, last_name, major_id, is_archived)
values ('e0000000-0000-0000-0000-000000000002', 'בדיקה', 'סטטי־בלבד', :'major_static', false)
on conflict (id) do update set major_id = excluded.major_id;
delete from public.student_projects where student_id = 'e0000000-0000-0000-0000-000000000002';

-- case 3: student with NO major anywhere
insert into public.students (id, first_name, last_name, major_id, is_archived)
values ('e0000000-0000-0000-0000-000000000003', 'בדיקה', 'ללא־מגמה', null, false)
on conflict (id) do update set major_id = null;
delete from public.student_projects where student_id = 'e0000000-0000-0000-0000-000000000003';

-- act as the authenticated super_admin
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);

do $$
begin
  if (select project_major_name from public.dashboard_rows()
       where student_id = 'e0000000-0000-0000-0000-000000000001') = 'מגמת פרויקט בדיקה' then
    raise notice 'PASS: project major wins when a current project exists';
  else
    raise exception 'FAIL: project major not shown for project student';
  end if;
end $$;

do $$
begin
  if (select project_major_name from public.dashboard_rows()
       where student_id = 'e0000000-0000-0000-0000-000000000002') = 'מגמה סטטית בדיקה' then
    raise notice 'PASS: students.major_id fallback resolves to major name';
  else
    raise exception 'FAIL: students.major_id fallback missing for project-less student';
  end if;
end $$;

do $$
declare v text;
begin
  select project_major_name into v from public.dashboard_rows()
   where student_id = 'e0000000-0000-0000-0000-000000000003';
  if v is null then
    raise notice 'PASS: student without any major renders blank (no fake data)';
  else
    raise exception 'FAIL: student without major should be null, got %', v;
  end if;
end $$;

rollback;
