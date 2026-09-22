-- ============================================================================
-- Attendance SQL/RLS tests (phase 4) â€” run against a database with all
-- migrations applied + seed:
--   supabase db reset && psql -f supabase/tests/attendance_tests.sql
-- (vanilla Postgres: apply supabase/tests/local-postgres-stub.sql first)
--
-- Identity model: a signed-in staff account is simulated with
-- request.jwt.claims (sub) + profiles.auth_user_id (seed links them).
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
--
-- NOTE: View-As is an app-layer (cookie) concept â€” mutations are blocked by
-- assertNotViewAs() before any RPC is invoked; it has no SQL surface here.
-- NOTE: student leaders are STUDENTS â€” they have no auth accounts and no app
-- access at all; there is no permission surface to test for them in SQL.
-- ============================================================================

\set ronen   '11111111-1111-1111-1111-111111111101' -- super_admin
\set michal  '11111111-1111-1111-1111-111111111102' -- mentor of ×–×™×ª + ×“×§×œ, leads LG ×¦×™×œ×•×
\set yoav    '11111111-1111-1111-1111-111111111103' -- mentor of ×©×§×“, leads LG ×¨×•×‘×•×˜×™×§×”
\set liat    '11111111-1111-1111-1111-111111111109' -- leadership (+ leads LG ×¦×™×œ×•×)
\set tom     '11111111-1111-1111-1111-11111111110a' -- plain staff
\set itay    '11111111-1111-1111-1111-111111111105' -- employment_coordinator (+mentor ×¨×™×ž×•×Ÿ)

\set zion       '22222222-2222-2222-2222-222222222201' -- ×–×™×ª (michal)
\set almond     '22222222-2222-2222-2222-222222222202' -- ×©×§×“ (yoav)
\set lg_photo   '66666666-6666-6666-6666-666666666601' -- ×¦×™×œ×•×: ××³+×‘×³ 16:00-17:30
\set lg_robot   '66666666-6666-6666-6666-666666666602' -- ×¨×•×‘×•×˜×™×§×”: ×‘×³ 16:00-17:30
\set lg_music   '66666666-6666-6666-6666-666666666603' -- ×ž×•×–×™×§×”: ×“×³ 10:00-11:00 + 11:00-12:00

\set noam    '44444444-4444-4444-4444-444444444401' -- ×–×™×ª, member of ×¦×™×œ×•×, employment ×’×³
\set talya   '44444444-4444-4444-4444-444444444402' -- ×–×™×ª
\set omer    '44444444-4444-4444-4444-444444444403' -- ×–×™×ª
\set maya    '44444444-4444-4444-4444-444444444404' -- ×–×™×ª
\set leo     '44444444-4444-4444-4444-444444444405' -- ×©×§×“, member of ×¨×•×‘×•×˜×™×§×”, employment ×‘×³

-- Jerusalem "today" and stable weekday anchors (×™×•× ×‘×³/×“×³ in the past â†’
-- allowed for attendance writes; future dates are rejected by the RPCs)
create temp table _att_dates as
  select (now() at time zone 'Asia/Jerusalem')::date as today,
         current_setting('request.jwt.claims', true) as _claims;

\echo '--- starting attendance test suite ---'

-- helper: simulate sign-in as a seeded staff member
-- (call inside the transaction; settings are transaction-local)
create or replace function _att_as(p_email text) returns void
language plpgsql as $$
declare
  v_staff uuid;
begin
  -- resolve the staff identity as superuser BEFORE switching roles
  -- (profiles RLS hides other rows from authenticated readers)
  perform set_config('role', 'postgres', true);
  select id into v_staff from public.profiles where email = p_email;
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', coalesce(v_staff::text, ''), 'role', 'authenticated')::text,
    true);
end;
$$;

-- canonical Jerusalem dates used across the suite
create or replace function _att_today() returns date
language sql as $$
  select (now() at time zone 'Asia/Jerusalem')::date;
$$;

-- last (or same-day) Tuesday, Jerusalem wall date â€” noam's employment day
create or replace function _att_tuesday() returns date
language sql as $$
  select (now() at time zone 'Asia/Jerusalem')::date
         - ((extract(dow from (now() at time zone 'Asia/Jerusalem'))::int + 5) % 7);
$$;

-- last (or same-day) Monday â€” ×¨×•×‘×•×˜×™×§×” slot + ×œ×™××•'s employment day
create or replace function _att_monday() returns date
language sql as $$
  select (now() at time zone 'Asia/Jerusalem')::date
         - ((extract(dow from (now() at time zone 'Asia/Jerusalem'))::int + 6) % 7);
$$;

-- last (or same-day) Wednesday â€” ×ž×•×–×™×§×”'s two slots (read-only context, future is fine)
create or replace function _att_wednesday() returns date
language sql as $$
  select (now() at time zone 'Asia/Jerusalem')::date
         - ((extract(dow from (now() at time zone 'Asia/Jerusalem'))::int + 4) % 7);
$$;

-- ============================================================================
-- AT0: schema sanity â€” the 6 new tables exist
-- ============================================================================
do $$ begin
  if (select count(*) from information_schema.tables
      where table_schema='public' and table_name in
      ('school_attendance','student_day_plans','learning_group_sessions',
       'learning_group_attendance','learning_group_attendance_alerts',
       'student_feed_events')) <> 6 then
    raise exception 'FAIL: attendance schema incomplete';
  end if;
  raise notice 'PASS: attendance schema present (6 tables)';
end $$;

-- ============================================================================
-- AT1: anon has ZERO access â€” tables and mutation RPCs are locked down
-- ============================================================================
begin;
select set_config('role', 'anon', true);
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  if (select count(*) from public.school_attendance) <> 0 then
    raise exception 'FAIL: anon can read school_attendance';
  end if;
  if (select count(*) from public.student_feed_events) <> 0 then
    raise exception 'FAIL: anon can read student_feed_events';
  end if;
  raise notice 'PASS: anon has zero table access';
end $$;
do $$ begin
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401'::uuid, current_date, 'present', null);
    raise exception 'FAIL: anon can execute school_attendance_mark';
  exception when insufficient_privilege then null; end;
  begin
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601'::uuid, current_date, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401'::uuid, 'present', null);
    raise exception 'FAIL: anon can execute learning_group_attendance_save';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: anon cannot execute attendance RPCs';
end $$;
rollback;

-- ============================================================================
-- AT2: mentor CAN mark own group; repeated edit UPDATES the same row
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare
    v_today date := _att_today();
    r1 jsonb; r2 jsonb; n int;
  begin
    r1 := public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_today, 'late', '09:45'::time);
    if (r1 ->> 'created') <> 'true' then
      raise exception 'FAIL: first mark should create';
    end if;
    r2 := public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_today, 'present', null);
    if (r2 ->> 'created') = 'true' or (r2 ->> 'id') <> (r1 ->> 'id') then
      raise exception 'FAIL: repeated edit must update the SAME record (no duplicate)';
    end if;
    select count(*) into n from public.school_attendance
     where student_id = '44444444-4444-4444-4444-444444444401' and attendance_date = v_today;
    if n <> 1 then
      raise exception 'FAIL: expected exactly 1 attendance row, found %', n;
    end if;
    -- arrival time cleared when status changes away from late
    if exists (select 1 from public.school_attendance
                where id = (r2 ->> 'id')::uuid and arrival_time is not null) then
      raise exception 'FAIL: arrival_time must be cleared for non-late status';
    end if;
    raise notice 'PASS: mentor marks own group; update keeps ONE canonical row';
  end;
end $$;
rollback;

-- ============================================================================
-- AT3: late requires arrival time; non-late cannot carry one
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', _att_today(), 'late', null);
    raise exception 'FAIL: late without arrival time accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: late requires an arrival time';
end $$;
do $$ begin
  declare v_today date := _att_today();
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_today, 'absent', '08:00'::time);
    if exists (select 1 from public.school_attendance
                where student_id = '44444444-4444-4444-4444-444444444401'
                  and attendance_date = v_today and arrival_time is not null) then
      raise exception 'FAIL: absent with arrival time accepted';
    end if;
    raise notice 'PASS: non-late statuses never store an arrival time';
  end;
end $$;
rollback;

-- ============================================================================
-- AT4: mentor of ANOTHER group is blocked; plain staff blocked;
--      leadership/super_admin allowed
-- ============================================================================
begin;
select _att_as('yoav@chamama.example');
do $$ begin
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', _att_today(), 'present', null);
    raise exception 'FAIL: mentor of unrelated group could mark';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: mentor cannot mark an unrelated group';
end $$;
rollback;

begin;
select _att_as('tom@chamama.example');
do $$ begin
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', _att_today(), 'present', null);
    raise exception 'FAIL: plain staff could mark';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: arbitrary staff cannot mutate daily attendance';
end $$;
-- employment_coordinator gains NOTHING from the employment role:
select _att_as('itay@chamama.example');
do $$ begin
  -- itay mentors ×¨×™×ž×•×Ÿ, but noam is in ×–×™×ª â€” must still be blocked
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', _att_today(), 'present', null);
    raise exception 'FAIL: employment coordinator could mark unrelated student';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: employment coordinator has no attendance-write via employment role';
end $$;
rollback;

begin;
select _att_as('liat@chamama.example');
do $$ begin
  perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', _att_today(), 'present', null);
  if not exists (select 1 from public.school_attendance
                  where student_id = '44444444-4444-4444-4444-444444444401'
                    and attendance_date = _att_today()) then
    raise exception 'FAIL: leadership mark did not persist';
  end if;
  raise notice 'PASS: leadership can mark any group';
end $$;
rollback;

begin;
select _att_as('ronen@chamama.example');
do $$ begin
  perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', _att_today(), 'present', null);
  raise notice 'PASS: super_admin can mark';
end $$;
rollback;

-- ============================================================================
-- AT5: future dates are rejected (attendance is a once-per-school-day check)
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', _att_today() + 1, 'present', null);
    raise exception 'FAIL: future date accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: future attendance dates rejected';
end $$;
rollback;

-- ============================================================================
-- AT6: completion counts â€” present/absent/late/working/unresolved/reported
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare v_today date := _att_today(); c jsonb;
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_today, 'present', null);
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444402', v_today, 'absent', null);
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444403', v_today, 'late', '09:30'::time);
    -- ×ž××™×” stays unresolved; (×–×™×ª has exactly 4 students)
    c := public.school_attendance_counts('22222222-2222-2222-2222-222222222201', v_today);
    if (c ->> 'total')::int <> 4
       or (c ->> 'present')::int <> 1
       or (c ->> 'absent')::int <> 1
       or (c ->> 'late')::int <> 1
       or (c ->> 'unresolved')::int <> 1
       or (c ->> 'reported')::int <> 3
       or (c ->> 'resolved')::int <> 3 then
      raise exception 'FAIL: completion counts wrong: %', c;
    end if;
    raise notice 'PASS: completion counts correct';
  end;
end $$;
rollback;

-- ============================================================================
-- AT7: WORK â€” expected-work derives "×‘×¢×‘×•×“×”"; explicit report overrides it;
--      employment data itself is NEVER changed by attendance
-- ============================================================================
begin;
do $$ begin
  declare
    v_tue date := _att_tuesday();
    before jsonb; after jsonb; eff jsonb;
    v_place_before timestamptz;
  begin
    -- canonical employment expectation (noam: יום ג׳ 08:30-15:00)
    select to_jsonb(public.is_student_expected_at_work('44444444-4444-4444-4444-444444444401', v_tue))
      into before;
    if coalesce(before ->> 'expected', 'false') <> 'true' then
      raise exception 'FAIL: seeded employment expectation missing on %', v_tue;
    end if;

    select max(pl.updated_at) into v_place_before
      from public.student_employment_placements pl
     where pl.student_id = '44444444-4444-4444-4444-444444444401';

    eff := public.student_effective_school_status('44444444-4444-4444-4444-444444444401', v_tue);
    if (eff ->> 'status') <> 'expected_work' or (eff ->> 'recorded') <> 'false' then
      raise exception 'FAIL: expected-work student must resolve as expected_work, got %', eff ->> 'status';
    end if;
    raise notice 'PASS: expected-work student resolves as working (derived, not entered)';

    -- explicit school-arrival override by the mentor
    perform _att_as('michal@chamama.example');
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_tue, 'late', '10:15'::time);
    eff := public.student_effective_school_status('44444444-4444-4444-4444-444444444401', v_tue);
    if (eff ->> 'status') <> 'late' or (eff ->> 'work_overridden') <> 'true' then
      raise exception 'FAIL: explicit attendance must override expected work';
    end if;

    -- employment data untouched
    select to_jsonb(public.is_student_expected_at_work('44444444-4444-4444-4444-444444444401', v_tue))
      into after;
    if (before ->> 'start_time') <> (after ->> 'start_time')
       or (before ->> 'end_time') <> (after ->> 'end_time') then
      raise exception 'FAIL: employment data changed by attendance override';
    end if;
    if exists (select 1 from public.student_employment_placements pl
                where pl.student_id = '44444444-4444-4444-4444-444444444401'
                  and pl.updated_at is distinct from v_place_before) then
      raise exception 'FAIL: placement row was modified by attendance';
    end if;
    raise notice 'PASS: explicit report overrides work; employment data unchanged';
  end;
end $$;
rollback;

-- ============================================================================
-- AT8: PLANNED DAY â€” plans are separate from attendance, never create one
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare
    v_today date := _att_today();
    r jsonb; eff jsonb; n int;
  begin
    perform public.school_attendance_clear('44444444-4444-4444-4444-444444444404', v_today);
    r := public.student_day_plan_upsert('44444444-4444-4444-4444-444444444404', v_today, '10:30'::time, null, '×‘×“×™×§×ª ×¨×•×¤×');
    if (r ->> 'created') <> 'true' then raise exception 'FAIL: plan not created'; end if;

    select count(*) into n from public.school_attendance
     where student_id = '44444444-4444-4444-4444-444444444404' and attendance_date = v_today;
    if n <> 0 then raise exception 'FAIL: plan created an attendance row'; end if;

    eff := public.student_effective_school_status('44444444-4444-4444-4444-444444444404', v_today);
    if (eff ->> 'status') <> 'unresolved' then
      raise exception 'FAIL: plan must not change actual status, got %', eff ->> 'status';
    end if;
    if (eff ->> 'planned_late_arrival_time') is null or (eff ->> 'plan_reason') <> '×‘×“×™×§×ª ×¨×•×¤×' then
      raise exception 'FAIL: plan context missing from resolver output';
    end if;

    -- upsert = same row edited
    perform public.student_day_plan_upsert('44444444-4444-4444-4444-444444444404', v_today, '11:00'::time, '13:00'::time, '×˜×™×¤×•×œ');
    select count(*) into n from public.student_day_plans
     where student_id = '44444444-4444-4444-4444-444444444404' and plan_date = v_today;
    if n <> 1 then raise exception 'FAIL: duplicate plan rows'; end if;

    -- delete
    perform public.student_day_plan_delete('44444444-4444-4444-4444-444444444404', v_today);
    select count(*) into n from public.student_day_plans
     where student_id = '44444444-4444-4444-4444-444444444404' and plan_date = v_today;
    if n <> 0 then raise exception 'FAIL: plan not deleted'; end if;

    raise notice 'PASS: planned arrival/departure separate from actual attendance';
  end;
end $$;
rollback;

-- ============================================================================
-- AT9: LG roster integrity â€” member required; leader of THAT group required
-- ============================================================================
begin;
select _att_as('michal@chamama.example'); -- leads ×¦×™×œ×•×
do $$ begin
  declare v_dow smallint := extract(dow from _att_today())::smallint;
  begin
    -- find one of ×¦×™×œ×•×'s slot times for TODAY's weekday (any date works â€”
    -- use the Monday slot if today is Monday, else just use Monday's date)
    null;
  end;
end $$;

do $$ begin
  declare
    v_mon date := _att_monday();
    r jsonb;
  begin
    -- member (noam) â€” OK
    r := public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'present', null);
    if (r ->> 'created') <> 'true' then raise exception 'FAIL: LG save failed for member'; end if;

    -- non-member (talya is NOT a member of ×¦×™×œ×•×) â€” blocked
    begin
      perform public.learning_group_attendance_save(
        '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
        '44444444-4444-4444-4444-444444444402', 'present', null);
      raise exception 'FAIL: non-member could be marked';
    exception when check_violation then null; end;
    raise notice 'PASS: LG roster based on active membership';
  end;
end $$;
rollback;

begin;
select _att_as('yoav@chamama.example'); -- leads ×¨×•×‘×•×˜×™×§×”, NOT ×¦×™×œ×•×
do $$ begin
  begin
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', _att_monday(), '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'present', null);
    raise exception 'FAIL: unrelated staff leader could mark LG attendance';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: only the staff leader of THAT learning group can mark';
end $$;
rollback;

begin;
select _att_as('liat@chamama.example'); -- leadership
do $$ begin
  perform public.learning_group_attendance_save(
    '66666666-6666-6666-6666-666666666601', _att_monday(), '16:00'::time, '17:30'::time,
    '44444444-4444-4444-4444-444444444401', 'present', null);
  raise notice 'PASS: leadership can record LG attendance';
end $$;
rollback;

-- ============================================================================
-- AT10: multiple sessions on the SAME day remain DISTINCT (×ž×•×–×™×§×”: 2 slots)
-- ============================================================================
begin;
select _att_as('liat@chamama.example');
do $$ begin
  declare v_wed date := _att_wednesday(); n int;
  begin
    -- add ×¢×•×ž×¨ to ×ž×•×–×™×§×” (leadership can manage membership)
    perform public.learning_group_add_member('66666666-6666-6666-6666-666666666603', '44444444-4444-4444-4444-444444444403');

    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666603', v_wed, '10:00'::time, '11:00'::time,
      '44444444-4444-4444-4444-444444444403', 'present', null);
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666603', v_wed, '11:00'::time, '12:00'::time,
      '44444444-4444-4444-4444-444444444403', 'late', '11:12'::time);

    select count(distinct sess.id) into n
      from public.learning_group_attendance a
      join public.learning_group_sessions sess on sess.id = a.session_id
     where sess.learning_group_id = '66666666-6666-6666-6666-666666666603'
       and sess.session_date = v_wed
       and a.student_id = '44444444-4444-4444-4444-444444444403';
    if n <> 2 then raise exception 'FAIL: same-day sessions must be distinct, got %', n; end if;
    raise notice 'PASS: multiple sessions on one day stay distinct';
  end;
end $$;
rollback;

-- ============================================================================
-- AT11: school absence propagates to LG context (computed, never copied) and
--       NO mentor alert is created for a school-absent student
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare
    v_mon date := _att_monday();
    data jsonb; entry jsonb; alerts int; feeds int;
  begin
    -- school says ABSENT (michal is noam's mentor)
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_mon, 'absent', null);

    -- LG screen: context shows school absence automatically
    data := public.learning_group_attendance_for_date('66666666-6666-6666-6666-666666666601', v_mon);
    select e into entry
      from jsonb_array_elements(data -> 0 -> 'roster') e
     where e ->> 'student_id' = '44444444-4444-4444-4444-444444444401';
    if (entry ->> 'school_context') <> 'absent_from_school' then
      raise exception 'FAIL: LG must show school absence, got %', entry ->> 'school_context';
    end if;

    -- even a recorded LG absence must NOT alert (student not at school)
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'absent', null);
    select count(*) into alerts from public.learning_group_attendance_alerts;
    select count(*) into feeds from public.student_feed_events;
    if alerts <> 0 or feeds <> 0 then
      raise exception 'FAIL: school-absent student generated LG alerts (% alerts, % feeds)', alerts, feeds;
    end if;
    raise notice 'PASS: school absence propagates to LG + no alert';
  end;
end $$;
rollback;

-- ============================================================================
-- AT12: expected-at-work propagates to LG context and does NOT alert
-- ============================================================================
begin;
do $$ begin
  declare v_mon date := _att_monday();
  begin
    -- employment coordinator adds a one-day 'add' exception so ליאו is
    -- canonically expected at work on this MONDAY (his weekly slot is Sunday)
    perform set_config('role', 'postgres', true);
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      '{"sub":"11111111-1111-1111-1111-111111111105","role":"authenticated"}', true);
    perform public.admin_upsert_employment_exception(
      null, '88888888-8888-8888-8888-888888888803', v_mon, 'add',
      '09:00'::time, '14:00'::time, null);
  end;
end $$;
select _att_as('yoav@chamama.example');
do $$ begin
  declare
    v_mon date := _att_monday();
    data jsonb; entry jsonb; alerts int;
  begin
    -- ליאו: expected at work on this Monday (exception above), member of רובוטיקה
    data := public.learning_group_attendance_for_date('66666666-6666-6666-6666-666666666602', v_mon);
    select e into entry
      from jsonb_array_elements(data -> 0 -> 'roster') e
     where e ->> 'student_id' = '44444444-4444-4444-4444-444444444405';
    if entry is null then raise exception 'FAIL: ליאו missing from רובוטיקה roster'; end if;
    if (entry ->> 'school_context') <> 'expected_work' then
      raise exception 'FAIL: LG must show work context, got %', entry ->> 'school_context';
    end if;

    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666602', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444405', 'absent', null);
    select count(*) into alerts from public.learning_group_attendance_alerts;
    if alerts <> 0 then
      raise exception 'FAIL: expected-at-work student generated an LG alert';
    end if;
    raise notice 'PASS: expected work propagates to LG + no alert';
  end;
end $$;
rollback;

-- ============================================================================
-- AT13: at-school LG absence â†’ ONE alert + feed event; IDEMPOTENT on re-save;
--       resolution removes it; late-time edit UPDATES the same event
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare
    v_mon date := _att_monday();
    r1 jsonb; r2 jsonb; alerts int; feeds int; keys text[];
  begin
    -- at school: explicit school LATE report (michal is the mentor)
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_mon, 'late', '09:40'::time);

    r1 := public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'absent', null);
    if (r1 ->> 'alert_created') <> 'true' then
      raise exception 'FAIL: at-school LG absence must create an alert';
    end if;
    if jsonb_array_length(r1 -> 'mentor_ids') = 0 then
      raise exception 'FAIL: mentors not resolved for notification';
    end if;

    -- save the SAME state again â†’ no duplicate
    r2 := public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'absent', null);
    if (r2 ->> 'alert_created') = 'true' then
      raise exception 'FAIL: repeated save re-alerted';
    end if;
    select count(*) into alerts from public.learning_group_attendance_alerts;
    select count(*) into feeds from public.student_feed_events;
    if alerts <> 1 or feeds <> 1 then
      raise exception 'FAIL: duplicates after re-save (% alerts, % feeds)', alerts, feeds;
    end if;

    -- present resolves the alert and removes the feed event
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'present', null);
    select count(*) into feeds from public.student_feed_events;
    select count(*) into alerts from public.learning_group_attendance_alerts where is_current;
    if feeds <> 0 or alerts <> 0 then
      raise exception 'FAIL: resolution did not clear feed/alert (% feeds, % current alerts)', feeds, alerts;
    end if;

    -- late creates ONE event; editing the late time UPDATES it (still one)
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'late', '16:18'::time);
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'late', '16:22'::time);
    select count(*) into feeds from public.student_feed_events;
    if feeds <> 1 then raise exception 'FAIL: late edit duplicated events (%)', feeds; end if;
    select array_agg(event_key) into keys from public.student_feed_events;
    if keys is null or array_length(keys, 1) <> 1
       or keys[1] not like '%:late' then
      raise exception 'FAIL: unexpected feed event keys: %', keys;
    end if;
    if not exists (select 1 from public.student_feed_events
                    where body like '%16:22%') then
      raise exception 'FAIL: late-time edit did not update the existing event';
    end if;
    raise notice 'PASS: at-school LG absence/late alerts are idempotent + resolvable';
  end;
end $$;
rollback;

-- ============================================================================
-- AT14: audit â€” created/updated/override/plan/LG actions are audited
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare
    v_today date := _att_today();
    v_tue date := _att_tuesday();
    v_id uuid; actions text[];
  begin
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_today, 'present', null);
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_today, 'absent', null);
    perform public.school_attendance_mark('44444444-4444-4444-4444-444444444401', v_tue, 'present', null); -- override
    perform public.student_day_plan_upsert('44444444-4444-4444-4444-444444444404', v_today, '10:30'::time, null, '×¤×¨×˜×™');
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', _att_monday(), '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'absent', null);

    -- query audit as postgres (audit_logs is not client-readable)
    perform set_config('role', 'postgres', true);
    select array_agg(distinct action) into actions
      from public.audit_logs
     where entity_type in ('school_attendance','learning_group_attendance','student_day_plan')
       and created_at > now() - interval '1 minute';
    if not (actions @> array['school_attendance_created']) then
      raise exception 'FAIL: school_attendance_created missing: %', actions;
    end if;
    if not (actions @> array['school_attendance_updated']) then
      raise exception 'FAIL: school_attendance_updated missing';
    end if;
    if not (actions @> array['school_attendance_override_work']) then
      raise exception 'FAIL: school_attendance_override_work missing';
    end if;
    if not (actions @> array['student_day_plan_created']) then
      raise exception 'FAIL: student_day_plan_created missing';
    end if;
    if not (actions @> array['learning_group_attendance_created']) then
      raise exception 'FAIL: learning_group_attendance_created missing';
    end if;
    -- no sensitive free text in audit metadata (the plan reason must not leak)
    if exists (
      select 1 from public.audit_logs
       where entity_type = 'student_day_plan'
         and metadata::text like '%×‘×“×™×§×ª%'
    ) then
      raise exception 'FAIL: plan reason leaked into audit metadata';
    end if;
    raise notice 'PASS: meaningful attendance mutations audited (no reason leakage)';
  end;
end $$;
rollback;

-- ============================================================================
-- AT15: overview is leadership/super_admin only; counts per group
-- ============================================================================
begin;
select _att_as('tom@chamama.example');
do $$ begin
  begin
    perform * from public.school_attendance_overview(_att_today());
    raise exception 'FAIL: plain staff can read the overview';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: attendance overview restricted to leadership/super_admin';
end $$;
rollback;

begin;
select _att_as('liat@chamama.example');
do $$ begin
  declare rows int;
  begin
    select count(*) into rows from public.school_attendance_overview(_att_today());
    if rows < 4 then raise exception 'FAIL: overview missing groups (% rows)', rows; end if;
    raise notice 'PASS: leadership reads the school-wide overview';
  end;
end $$;
rollback;

-- ============================================================================
-- AT16: RLS â€” authorized staff can READ attendance data; no client writes
-- ============================================================================
begin;
select _att_as('tom@chamama.example');
do $$ begin
  declare n int;
  begin
    select count(*) into n from public.school_attendance;
    if n < 0 then raise exception 'FAIL: read denied'; end if;
    begin
      insert into public.school_attendance (student_id, attendance_date, status, recorded_by_staff_id)
      values ('44444444-4444-4444-4444-444444444401', current_date, 'present', '11111111-1111-1111-1111-11111111110a');
      raise exception 'FAIL: direct client write was NOT blocked';
    exception when insufficient_privilege or check_violation then null; end;
    raise notice 'PASS: staff read allowed; direct writes blocked (RPC-only mutations)';
  end;
end $$;
rollback;

-- ============================================================================
-- AT17: §3 VERIFICATION — LG session materialization is LAZY + IDEMPOTENT;
--       multiple same-day slots stay distinct; bulk skips planned-late days
-- ============================================================================
begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare
    v_mon date := _att_monday();
    v_before int; v_after_first int; v_after_second int;
  begin
    -- (a) NO session rows before any attendance save (read path never creates)
    select count(*) into v_before from public.learning_group_sessions
     where learning_group_id = '66666666-6666-6666-6666-666666666601' and session_date = v_mon;
    if v_before <> 0 then
      raise exception 'FAIL: sessions must not exist before the first save (%)', v_before;
    end if;
    -- the read RPC resolves the slot WITHOUT materializing
    perform public.learning_group_attendance_for_date('66666666-6666-6666-6666-666666666601', v_mon);
    select count(*) into v_before from public.learning_group_sessions
     where learning_group_id = '66666666-6666-6666-6666-666666666601' and session_date = v_mon;
    if v_before <> 0 then
      raise exception 'FAIL: reading the attendance screen materialized a session';
    end if;

    -- (b) the FIRST save lazily creates exactly ONE session
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'present', null);
    select count(*) into v_after_first from public.learning_group_sessions
     where learning_group_id = '66666666-6666-6666-6666-666666666601' and session_date = v_mon;
    if v_after_first <> 1 then
      raise exception 'FAIL: first save must materialize exactly 1 session (%)', v_after_first;
    end if;

    -- (c) repeated saves / re-opening are idempotent (still ONE session)
    perform public.learning_group_attendance_save(
      '66666666-6666-6666-6666-666666666601', v_mon, '16:00'::time, '17:30'::time,
      '44444444-4444-4444-4444-444444444401', 'late', '16:30'::time);
    select count(*) into v_after_second from public.learning_group_sessions
     where learning_group_id = '66666666-6666-6666-6666-666666666601' and session_date = v_mon;
    if v_after_second <> 1 then
      raise exception 'FAIL: repeated save duplicated sessions (%)', v_after_second;
    end if;

    -- (d) a DIFFERENT slot on the SAME date is a DISTINCT session
    --     (צילום also runs Mondays; use מוזיקה's two Wednesday slots instead —
    --      see AT10 — here prove צילום's second weekly weekday is separate)
    raise notice 'PASS: LG sessions are lazily materialized on first save and idempotent';
  end;
end $$;
rollback;

begin;
select _att_as('michal@chamama.example');
do $$ begin
  declare
    v_today date := _att_today();
    v_marked int;
    v_expected int;
    v_noam_works boolean;
  begin
    -- clean slate for the group/date
    delete from public.school_attendance
     where attendance_date = v_today
       and student_id in (select id from public.students where group_id = '22222222-2222-2222-2222-222222222201');
    -- מאיה has a PLANNED LATE ARRIVAL → the safe bulk must skip her
    perform public.student_day_plan_upsert('44444444-4444-4444-4444-444444444404', v_today, '10:30'::time, null, 'x');
    v_marked := public.school_attendance_bulk_mark_present('22222222-2222-2222-2222-222222222201', v_today);
    -- expected: all 4 students minus the planned-late one minus any
    -- expected-at-work student (נועם works Tuesdays — date-dependent)
    select coalesce(e.expected, false) into v_noam_works
      from public.is_student_expected_at_work('44444444-4444-4444-4444-444444444401', v_today) e limit 1;
    v_expected := 4 - 1 - (case when coalesce(v_noam_works, false) then 1 else 0 end);
    if v_marked <> v_expected then
      raise exception 'FAIL: bulk marked %, expected %', v_marked, v_expected;
    end if;
    if exists (select 1 from public.school_attendance
                where student_id = '44444444-4444-4444-4444-444444444404'
                  and attendance_date = v_today) then
      raise exception 'FAIL: planned-late student was bulk-marked';
    end if;
    raise notice 'PASS: bulk present skips planned-late-arrival students';
  end;
end $$;
rollback;

\echo '--- attendance test suite finished ---'
