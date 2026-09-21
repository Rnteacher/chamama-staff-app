-- ============================================================================
-- Learning Groups SQL/RLS tests — run against a database with all migrations
-- applied + seed:
--   supabase db reset && psql -f supabase/tests/learning_group_tests.sql
-- (vanilla Postgres: apply supabase/tests/local-postgres-stub.sql first)
--
-- Identity model: a signed-in staff account is simulated with
-- request.jwt.claims (sub + email) plus profiles.auth_user_id claim.
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

\set ronen   '11111111-1111-1111-1111-111111111101' -- super_admin
\set michal  '11111111-1111-1111-1111-111111111102' -- mentor, staff leader of צילום
\set liat    '11111111-1111-1111-1111-111111111109' -- leadership (+ staff leader צילום)
\set tom     '11111111-1111-1111-1111-11111111110a' -- plain staff (no leadership)
\set yoav    '11111111-1111-1111-1111-111111111103' -- mentor, staff leader of רובוטיקה

-- seeded learning groups
\set lg_photo    '66666666-6666-6666-6666-666666666601' -- צילום: א׳ 16:00-17:30 + ב׳ 16:00-17:30
\set lg_robot    '66666666-6666-6666-6666-666666666602' -- רובוטיקה: ב׳ 16:00-17:30 (conflicts with photo)
\set lg_music    '66666666-6666-6666-6666-666666666603' -- מוזיקה: ד׳ 10:00-11:00 + 11:00-12:00 (touching)
\set lg_window   '66666666-6666-6666-6666-666666666611' -- seeded open window ('dev-lg-token')

\set noam    '44444444-4444-4444-4444-444444444401' -- זית
\set talya   '44444444-4444-4444-4444-444444444402' -- זית
\set omer    '44444444-4444-4444-4444-444444444403' -- זית
\set leo     '44444444-4444-4444-4444-444444444405' -- שקד
\set zion_group '22222222-2222-2222-2222-222222222201'

\echo '--- starting learning-group test suite ---'

-- helper: sign in as a seeded staff member (claims the auth account)
-- usage: select 'auth' as op; ... written inline per test below.

-- ============================================================================
-- LG0: schema sanity
-- ============================================================================
do $$ begin
  if (select count(*) from information_schema.tables
      where table_schema='public' and table_name in
      ('learning_groups','learning_group_weekly_slots','learning_group_staff_leaders',
       'learning_group_student_leaders','learning_group_memberships',
       'learning_group_registration_windows','learning_group_registration_window_groups',
       'learning_group_registrations')) <> 8 then
    raise exception 'FAIL: learning-group schema incomplete';
  end if;
  raise notice 'PASS: learning-group schema present (8 tables)';
end $$;

-- ============================================================================
-- LG1: the shared overlap primitive — touching slots are NOT a conflict
-- ============================================================================
do $$ begin
  if public.weekly_slots_overlap(3::smallint, '10:00'::time, '11:00'::time, 3::smallint, '11:00'::time, '12:00'::time) then
    raise exception 'FAIL: touching slots wrongly reported as overlap';
  end if;
  if not public.weekly_slots_overlap(1::smallint, '16:00'::time, '17:30'::time, 1::smallint, '16:30'::time, '18:00'::time) then
    raise exception 'FAIL: overlapping same-weekday slots not detected';
  end if;
  if public.weekly_slots_overlap(1::smallint, '16:00'::time, '17:30'::time, 2::smallint, '16:00'::time, '17:30'::time) then
    raise exception 'FAIL: different weekdays wrongly reported as overlap';
  end if;
  raise notice 'PASS: weekly_slots_overlap primitive (touching/overlap/different-day)';
end $$;

-- ============================================================================
-- LG2: slot constraints — end > start, weekday bounds, duplicate identical slot
-- ============================================================================
do $$ begin
  begin
    insert into public.learning_group_weekly_slots (learning_group_id, weekday, start_time, end_time)
    values ('66666666-6666-6666-6666-666666666601', 5, '18:00', '18:00');
    raise exception 'FAIL: equal start/end accepted';
  exception when check_violation then null; end;
  begin
    insert into public.learning_group_weekly_slots (learning_group_id, weekday, start_time, end_time)
    values ('66666666-6666-6666-6666-666666666601', 7, '18:00', '19:00');
    raise exception 'FAIL: weekday 7 accepted';
  exception when check_violation then null; end;
  begin
    insert into public.learning_group_weekly_slots (learning_group_id, weekday, start_time, end_time)
    values ('66666666-6666-6666-6666-666666666601', 0, '16:00', '17:30'); -- duplicate of seed
    raise exception 'FAIL: duplicate identical slot accepted';
  exception when unique_violation then null; end;
  raise notice 'PASS: slot constraints enforce end>start, weekday range, uniqueness';
end $$;

-- ============================================================================
-- LG3: RLS — staff can read learning groups; anon reads nothing
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.learning_groups) <> 4 then
    raise exception 'FAIL: staff cannot read learning groups';
  end if;
  if (select count(*) from public.learning_group_memberships) < 3 then
    raise exception 'FAIL: staff cannot read memberships';
  end if;
  raise notice 'PASS: authorized staff reads learning groups + memberships';
end $$;
rollback;

begin;
select set_config('role', 'anon', true);
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  if (select count(*) from public.learning_groups) <> 0 then
    raise exception 'FAIL: anon can read learning_groups';
  end if;
  if (select count(*) from public.learning_group_registration_windows) <> 0 then
    raise exception 'FAIL: anon can read registration windows';
  end if;
  raise notice 'PASS: anon has zero table access';
end $$;
rollback;

-- ============================================================================
-- LG4: RLS — plain staff cannot read registration windows; leadership can
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.learning_group_registration_windows) <> 0 then
    raise exception 'FAIL: plain staff can read registration windows';
  end if;
  raise notice 'PASS: plain staff cannot read registration windows';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.learning_group_registration_windows) <> 1 then
    raise exception 'FAIL: leadership cannot read registration windows';
  end if;
  raise notice 'PASS: leadership reads registration windows';
end $$;
rollback;

-- ============================================================================
-- LG5: clients cannot INSERT learning groups directly (no insert policies)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  begin
    insert into public.learning_groups (name) values ('התחברות ישירה');
    raise exception 'FAIL: leadership inserted a learning group directly';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: direct client insert blocked (mutations via RPC only)';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ begin
  begin
    insert into public.learning_group_memberships (learning_group_id, student_id, source)
    values ('66666666-6666-6666-6666-666666666601', '44444444-4444-4444-4444-444444444402', 'manual');
    raise exception 'FAIL: staff leader inserted a membership directly';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: direct membership insert blocked (RPC only)';
end $$;
rollback;

-- ============================================================================
-- LG6: admin_upsert_learning_group — authorized create; unauthorized blocked
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ declare v jsonb; begin
  select public.admin_upsert_learning_group(
    null, 'קבוצת בדיקה', null, true,
    '[{"weekday":2,"start_time":"15:00","end_time":"16:30"}]'::jsonb,
    '{}'::uuid[], '{}'::uuid[]
  ) into v;
  if v ->> 'created' <> 'true' then raise exception 'FAIL: create failed'; end if;
  if (select count(*) from public.learning_group_weekly_slots s
      join public.learning_groups g on g.id = s.learning_group_id
      where g.name = 'קבוצת בדיקה') <> 1 then
    raise exception 'FAIL: slot not stored';
  end if;
  raise notice 'PASS: leadership creates a learning group with a slot';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.admin_upsert_learning_group(
      null, 'קבוצת בדיקה 2', null, true,
      '[{"weekday":2,"start_time":"15:00","end_time":"16:30"}]'::jsonb,
      '{}'::uuid[], '{}'::uuid[]);
    raise exception 'FAIL: plain staff created a learning group';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: unauthorized staff blocked from creating a learning group';
end $$;
rollback;

-- ============================================================================
-- LG7: admin_upsert_learning_group — validation errors (empty slots, bad
-- times, duplicate identical slots, overlapping selection is ALLOWED)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'ronen@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.admin_upsert_learning_group(null, 'שם', null, true, '[]'::jsonb, '{}'::uuid[], '{}'::uuid[]);
    raise exception 'FAIL: empty slots accepted';
  exception when check_violation then null; end;
  begin
    perform public.admin_upsert_learning_group(null, 'שם', null, true,
      '[{"weekday":2,"start_time":"17:00","end_time":"16:00"}]'::jsonb, '{}'::uuid[], '{}'::uuid[]);
    raise exception 'FAIL: end<=start accepted';
  exception when check_violation then null; end;
  begin
    perform public.admin_upsert_learning_group(null, 'שם', null, true,
      '[{"weekday":2,"start_time":"10:00","end_time":"11:00"},{"weekday":2,"start_time":"10:00","end_time":"11:00"}]'::jsonb,
      '{}'::uuid[], '{}'::uuid[]);
    raise exception 'FAIL: duplicate identical slots accepted';
  exception when check_violation then null; end;
  -- overlapping slots within the SAME group are not forbidden by the spec
  perform public.admin_upsert_learning_group(null, 'קבוצת חופפת פנימית', null, true,
    '[{"weekday":2,"start_time":"10:00","end_time":"11:30"},{"weekday":2,"start_time":"11:00","end_time":"12:30"}]'::jsonb,
    '{}'::uuid[], '{}'::uuid[]);
  raise notice 'PASS: slot validation (empty/end-before-start/duplicates rejected; partial overlap allowed)';
end $$;
rollback;

-- ============================================================================
-- LG8: membership RPC authorization
--   * staff leader of THAT group may add/remove
--   * staff leader of a DIFFERENT group blocked
--   * leadership allowed everywhere
--   * audit rows written
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare v boolean; begin
  v := public.learning_group_add_member('66666666-6666-6666-6666-666666666601', '44444444-4444-4444-4444-444444444402');
  if not v then raise exception 'FAIL: add returned false'; end if;
  if (select count(*) from public.learning_group_memberships
      where learning_group_id = '66666666-6666-6666-6666-666666666601'
        and student_id = '44444444-4444-4444-4444-444444444402'
        and ended_at is null and source = 'manual') <> 1 then
    raise exception 'FAIL: membership not created as manual';
  end if;
  raise notice 'PASS: staff leader of the group adds a member (source=manual)';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.learning_group_add_member('66666666-6666-6666-6666-666666666602', '44444444-4444-4444-4444-444444444402');
    raise exception 'FAIL: leader of another group added a member';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: staff leader of a DIFFERENT group blocked';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.learning_group_add_member('66666666-6666-6666-6666-666666666601', '44444444-4444-4444-4444-444444444402');
    raise exception 'FAIL: plain staff added a member';
  exception when insufficient_privilege then null; end;
  begin
    perform public.learning_group_remove_member('66666666-6666-6666-6666-666666666601', '44444444-4444-4444-4444-444444444401');
    raise exception 'FAIL: plain staff removed a member';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: unauthorized staff blocked from membership changes';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  perform public.learning_group_add_member('66666666-6666-6666-6666-666666666602', '44444444-4444-4444-4444-444444444401');
  perform public.learning_group_remove_member('66666666-6666-6666-6666-666666666602', '44444444-4444-4444-4444-444444444401');
  if exists (select 1 from public.learning_group_memberships
             where learning_group_id = '66666666-6666-6666-6666-666666666602'
               and student_id = '44444444-4444-4444-4444-444444444401'
               and ended_at is null) then
    raise exception 'FAIL: membership not soft-ended';
  end if;
  -- history preserved (ended row exists)
  if (select count(*) from public.learning_group_memberships
      where learning_group_id = '66666666-6666-6666-6666-666666666602'
        and student_id = '44444444-4444-4444-4444-444444444401') <> 1 then
    raise exception 'FAIL: ended membership history destroyed';
  end if;
  raise notice 'PASS: leadership manages members everywhere; remove soft-ends';
end $$;
-- audit rows are invisible to clients: check them as postgres
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.audit_logs
      where action in ('learning_group_member_added','learning_group_member_removed')) < 2 then
    raise exception 'FAIL: membership audit rows missing';
  end if;
  raise notice 'PASS: membership add/remove audited (server-side only)';
end $$;
rollback;

-- home-group safety: adding/removing a learning-group membership must never
-- touch students.group_id
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  perform public.learning_group_add_member('66666666-6666-6666-6666-666666666603', '44444444-4444-4444-4444-444444444401');
  perform public.learning_group_remove_member('66666666-6666-6666-6666-666666666603', '44444444-4444-4444-4444-444444444401');
  if (select group_id from public.students where id = '44444444-4444-4444-4444-444444444401')
     is distinct from '22222222-2222-2222-2222-222222222201' then
    raise exception 'FAIL: home group was altered by membership management';
  end if;
  raise notice 'PASS: membership changes never alter the home group';
end $$;
rollback;

-- ============================================================================
-- LG9: public submit — full happy path with automatic memberships
-- (runs as ANON to verify the public execute grant)
-- ============================================================================
begin;
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  select public.public_lgreg_submit(
    'dev-lg-token',
    '44444444-4444-4444-4444-444444444403', -- עומר (זית)
    '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666601'::uuid, '66666666-6666-6666-6666-666666666603'::uuid]
  ) into v;
  if v ->> 'status' <> 'ok' then
    raise exception 'FAIL: valid submission rejected: %', v;
  end if;
  -- memberships are invisible to anon: count them as postgres
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.learning_group_memberships
      where student_id = '44444444-4444-4444-4444-444444444403'
        and ended_at is null and source = 'registration') <> 2 then
    raise exception 'FAIL: memberships not auto-created';
  end if;
  raise notice 'PASS: submission auto-creates registration-sourced memberships';
end $$;
rollback;

-- ============================================================================
-- LG10: public submit — overlapping groups REJECTED server-side
-- ============================================================================
begin;
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  select public.public_lgreg_submit(
    'dev-lg-token',
    '44444444-4444-4444-4444-444444444403',
    '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666601'::uuid, '66666666-6666-6666-6666-666666666602'::uuid] -- צילום+רובוטיקה conflict on Monday
  ) into v;
  if v ->> 'status' = 'ok' then
    raise exception 'FAIL: overlapping selection accepted server-side';
  end if;
  -- memberships are invisible to anon: count them as postgres
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.learning_group_memberships
      where student_id = '44444444-4444-4444-4444-444444444403'
        and ended_at is null and source = 'registration') <> 0 then
    raise exception 'FAIL: rejected submission created memberships';
  end if;
  raise notice 'PASS: malicious/direct overlapping submit rejected server-side (no side effects)';
end $$;
rollback;

-- touching slots ACCEPTED: a group whose slots only TOUCH מוזיקה's slots
-- (ד׳ 09:00–10:00 touches 10:00–11:00; מוזיקה also has 11:00–12:00) fits.
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'ronen@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
select set_config('role', 'postgres', true);
do $$ declare v jsonb; v_new uuid; begin
  v := public.admin_upsert_learning_group(null, 'קבוצת ד׳ בוקר', null, true,
    '[{"weekday":3,"start_time":"09:00","end_time":"10:00"}]'::jsonb, '{}'::uuid[], '{}'::uuid[]);
  v_new := (v ->> 'id')::uuid;
  insert into public.learning_group_registration_window_groups (registration_window_id, learning_group_id)
  values ('66666666-6666-6666-6666-666666666611', v_new);
  select public.public_lgreg_submit(
    'dev-lg-token',
    '44444444-4444-4444-4444-444444444403',
    '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666603'::uuid, v_new] -- מוזיקה ד׳ 10:00-11:00 touches 09:00-10:00
  ) into v;
  if v ->> 'status' <> 'ok' then
    raise exception 'FAIL: touching-slot selection rejected: %', v;
  end if;
  raise notice 'PASS: touching slots accepted at submit';
end $$;
rollback;

-- multi-slot conflict: a multi-slot group conflicts when ANY of its slots
-- overlaps (here: only the SECOND Monday slot of צילום)
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'ronen@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
select set_config('role', 'postgres', true);
do $$ declare v jsonb; v_new uuid; begin
  -- group that conflicts ONLY with צילום's SECOND slot (Monday), not the first
  v := public.admin_upsert_learning_group(null, 'קבוצת ב׳ בלבד', null, true,
    '[{"weekday":1,"start_time":"17:00","end_time":"18:00"}]'::jsonb, '{}'::uuid[], '{}'::uuid[]);
  v_new := (v ->> 'id')::uuid;
  insert into public.learning_group_registration_window_groups (registration_window_id, learning_group_id)
  values ('66666666-6666-6666-6666-666666666611', v_new);
  select public.public_lgreg_submit(
    'dev-lg-token',
    '44444444-4444-4444-4444-444444444403',
    '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666601'::uuid, v_new]
  ) into v;
  if v ->> 'status' = 'ok' then
    raise exception 'FAIL: multi-slot conflict missed (second slot)';
  end if;
  raise notice 'PASS: multi-slot groups conflict on ANY overlapping slot combination';
end $$;
rollback;

-- ============================================================================
-- LG11: resubmission — provenance respected
--   1. submit A+צילום → memberships created (registration-sourced)
--   2. leadership manually adds the student to רובוטיקה
--   3. resubmit with ONLY מוזיקה → צילום membership ends; manual רובוטיקה STAYS
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ declare v jsonb; begin
  select public.public_lgreg_submit(
    'dev-lg-token', '44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666601'::uuid, '66666666-6666-6666-6666-666666666603'::uuid]
  ) into v;
  if v ->> 'status' <> 'ok' then raise exception 'FAIL: first submit failed'; end if;

  perform public.learning_group_add_member('66666666-6666-6666-6666-666666666602', '44444444-4444-4444-4444-444444444403');

  select public.public_lgreg_submit(
    'dev-lg-token', '44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666603'::uuid]
  ) into v;
  if v ->> 'status' <> 'ok' then raise exception 'FAIL: resubmit failed'; end if;

  -- the deselected registration membership ended
  if exists (select 1 from public.learning_group_memberships
             where student_id = '44444444-4444-4444-4444-444444444403'
               and learning_group_id = '66666666-6666-6666-6666-666666666601'
               and ended_at is null) then
    raise exception 'FAIL: deselected registration membership not ended';
  end if;
  -- the manual membership SURVIVED
  if not exists (select 1 from public.learning_group_memberships
             where student_id = '44444444-4444-4444-4444-444444444403'
               and learning_group_id = '66666666-6666-6666-6666-666666666602'
               and source = 'manual' and ended_at is null) then
    raise exception 'FAIL: manual membership destroyed by resubmission';
  end if;
  -- history preserved for the ended row
  if (select count(*) from public.learning_group_memberships
      where student_id = '44444444-4444-4444-4444-444444444403'
        and learning_group_id = '66666666-6666-6666-6666-666666666601') <> 1 then
    raise exception 'FAIL: ended registration membership history destroyed';
  end if;
  -- one registration row only
  if (select count(*) from public.learning_group_registrations
      where student_id = '44444444-4444-4444-4444-444444444403') <> 1 then
    raise exception 'FAIL: duplicate registrations per window+student';
  end if;
  raise notice 'PASS: resubmission syncs only its own registrations; manual memberships preserved';
end $$;
rollback;

-- ============================================================================
-- LG12: public submit — window state + student validation
-- ============================================================================
do $$ declare v jsonb; begin
  select public.public_lgreg_submit(
    'no-such-token', '44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666601'::uuid]) into v;
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: bad token not invalid'; end if;
  raise notice 'PASS: invalid token rejected';
end $$;

begin;
select set_config('role', 'postgres', true);
update public.learning_group_registration_windows set closes_at = now() - interval '1 hour'
 where id = '66666666-6666-6666-6666-666666666611';
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  select public.public_lgreg_submit(
    'dev-lg-token', '44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666601'::uuid]) into v;
  if v ->> 'status' <> 'closed' then raise exception 'FAIL: closed window accepted submit'; end if;
  raise notice 'PASS: closed window rejects submit';
end $$;
rollback;

begin;
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  -- student NOT in the claimed home group (עומר is in זית, not שקד)
  select public.public_lgreg_submit(
    'dev-lg-token', '44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222202',
    array['66666666-6666-6666-6666-666666666601'::uuid]) into v;
  if v ->> 'status' = 'ok' then raise exception 'FAIL: student/home-group mismatch accepted'; end if;
  -- a group NOT selectable in the window (ניו-מדיה inactive/not in window)
  select public.public_lgreg_submit(
    'dev-lg-token', '44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222201',
    array['66666666-6666-6666-6666-666666666604'::uuid]) into v;
  if v ->> 'status' = 'ok' then raise exception 'FAIL: non-selectable group accepted'; end if;
  -- empty selection
  select public.public_lgreg_submit(
    'dev-lg-token', '44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222201',
    array[]::uuid[]) into v;
  if v ->> 'status' = 'ok' then raise exception 'FAIL: empty selection accepted'; end if;
  raise notice 'PASS: student/home-group mismatch, non-selectable group, empty selection rejected';
end $$;
rollback;

-- ============================================================================
-- LG13: public RPCs expose minimal data; revoked/deleted windows fail closed
-- ============================================================================
begin;
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  select public.public_lgreg_overview('dev-lg-token') into v;
  if v ->> 'status' <> 'open' then raise exception 'FAIL: seeded window not open'; end if;
  if v -> 'home_groups' is null or v -> 'learning_groups' is null then
    raise exception 'FAIL: overview missing group lists';
  end if;
  -- no sensitive fields leak
  if v::text like '%email%' or v::text like '%auth_user%' then
    raise exception 'FAIL: overview leaked sensitive fields';
  end if;
  raise notice 'PASS: public overview works and exposes minimal data';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.learning_group_registration_windows set is_revoked = true where id = '66666666-6666-6666-6666-666666666611';
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  select public.public_lgreg_overview('dev-lg-token') into v;
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: revoked window still resolvable'; end if;
  raise notice 'PASS: revoked window fails closed';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
delete from public.learning_group_registration_windows where id = '66666666-6666-6666-6666-666666666611';
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  select public.public_lgreg_overview('dev-lg-token') into v;
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: deleted window still resolvable'; end if;
  raise notice 'PASS: deleted window fails closed';
end $$;
rollback;

-- ============================================================================
-- LG14: tokens are never stored as plaintext
-- ============================================================================
do $$ begin
  if exists (select 1 from public.learning_group_registration_windows
             where token_hash = 'dev-lg-token') then
    raise exception 'FAIL: plaintext token stored';
  end if;
  if exists (select 1 from public.learning_group_registration_windows
             where encrypted_token = 'dev-lg-token') then
    raise exception 'FAIL: plaintext token stored in encrypted column';
  end if;
  raise notice 'PASS: no plaintext token at rest (hash + encrypted copy only)';
end $$;

-- ============================================================================
-- LG15: future-schedule queries
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ begin
  -- "which learning groups run on Monday?" → צילום (ב׳) + רובוטיקה (ב׳)
  if (select count(*) from public.learning_groups_on_weekday(1::smallint)) <> 2 then
    raise exception 'FAIL: learning_groups_on_weekday(1) wrong';
  end if;
  if (select count(*) from public.learning_groups_on_weekday(6::smallint)) <> 0 then
    raise exception 'FAIL: learning_groups_on_weekday(6) wrong';
  end if;
  -- "which groups does מיכל lead on Sunday?" → צילום slot א׳
  if (select count(*) from public.staff_learning_groups_on_weekday(
        '11111111-1111-1111-1111-111111111102', 0::smallint)) <> 1 then
    raise exception 'FAIL: staff_learning_groups_on_weekday wrong';
  end if;
  raise notice 'PASS: future-schedule weekday queries work';
end $$;
rollback;

begin;
select set_config('role', 'anon', true);
do $$ begin
  begin
    perform public.learning_groups_on_weekday(0::smallint);
    raise exception 'FAIL: anon can query weekday schedule';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: weekday queries denied to anon';
end $$;
rollback;

-- attendance-ready roster primitive: current roster × scheduled slots
do $$ begin
  -- נועם is a manual member of צילום; on any Sunday the roster shows him
  if (select count(*) from public.learning_group_roster_on_date(
        '66666666-6666-6666-6666-666666666601', date '2026-09-20')) <> 1 then -- 2026-09-20 is a Sunday
    raise exception 'FAIL: roster_on_date wrong for Sunday';
  end if;
  -- עומר's membership ended → not on the מוזיקה roster
  if exists (select 1 from public.learning_group_roster_on_date(
        '66666666-6666-6666-6666-666666666603', date '2026-09-23')
      where student_id = '44444444-4444-4444-4444-444444444403') then -- Wednesday
    raise exception 'FAIL: ended membership appears in roster';
  end if;
  raise notice 'PASS: attendance-ready roster primitive (group+date+slot+roster)';
end $$;

\echo '--- learning-group test suite finished (no FAIL above = clean) ---'
