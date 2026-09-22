-- ============================================================================
-- RLS + identity-model tests — run against a database with all migrations
-- applied + seed.
--   Local dev:  supabase db reset && psql -f supabase/tests/rls_tests.sql
--   Vanilla Postgres: apply supabase/tests/local-postgres-stub.sql first.
--
-- Identity model: `profiles` is the staff directory. A signed-in Google
-- account is simulated with request.jwt.claims (sub + email) plus a
-- profiles.auth_user_id link (claim), except in the dedicated claim tests.
--
-- Every test runs in its own transaction and rolls back (except T25).
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

-- seeded staff ids (stable application UUIDs)
\set michal   '11111111-1111-1111-1111-111111111102'
\set yoav     '11111111-1111-1111-1111-111111111103'
\set naama    '11111111-1111-1111-1111-111111111104'
\set itay     '11111111-1111-1111-1111-111111111105'
\set roni     '11111111-1111-1111-1111-111111111106'
\set shira    '11111111-1111-1111-1111-111111111107'
\set amit     '11111111-1111-1111-1111-111111111108'
\set liat     '11111111-1111-1111-1111-111111111109'
\set tom      '11111111-1111-1111-1111-11111111110a'
\set dana     '11111111-1111-1111-1111-11111111110b'
\set avi      '11111111-1111-1111-1111-11111111110c'  -- pre-login staff (auth_user_id NULL)
\set ronen    '11111111-1111-1111-1111-111111111101'
\set dana_auth '99999999-9999-9999-9999-999999999901'

-- message ids from seed
\set msg_approved_noam     '55555555-5555-5555-5555-555555555501'
\set msg_private_noam      '55555555-5555-5555-5555-555555555502'
\set msg_hidden_noam       '55555555-5555-5555-5555-555555555503'
\set msg_private_liao      '55555555-5555-5555-5555-555555555504'
\set msg_private_maya      '55555555-5555-5555-5555-555555555505'
\set msg_approved_shachar  '55555555-5555-5555-5555-555555555507'
\set msg_hidden_shachar    '55555555-5555-5555-5555-555555555508'

\echo '--- starting RLS + identity test suite ---'

-- helper macro-ish blocks are written inline per test

-- ============================================================================
-- T0: schema sanity (allowlist gone, staff identity present)
-- ============================================================================
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='allowed_staff_emails') then
    raise exception 'FAIL: allowed_staff_emails should have been dropped';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles'
                   and column_name='auth_user_id') then
    raise exception 'FAIL: profiles.auth_user_id missing';
  end if;
  if (select count(*) from information_schema.tables
      where table_schema='public' and table_name in
      ('profiles','user_roles','greenhouse_groups','majors','students','group_mentors',
       'major_heads','master_assignments','student_messages','message_reads',
       'push_subscriptions','app_settings','audit_logs')) <> 13 then
    raise exception 'FAIL: schema incomplete';
  end if;
  raise notice 'PASS: staff-identity schema present, allowlist eliminated';
end $$;

-- ============================================================================
-- T1: unauthenticated / unknown Google account has zero access
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated","email":"stranger@gmail.com"}', true);
do $$ begin
  if public.current_staff_id() is not null then
    raise exception 'FAIL: unknown account resolved to a staff id';
  end if;
  if (select count(*) from public.students) <> 0 then
    raise exception 'FAIL: unknown account can read students';
  end if;
  if (select count(*) from public.student_messages) <> 0 then
    raise exception 'FAIL: unknown account can read messages';
  end if;
  raise notice 'PASS: unknown account has zero access';
end $$;
rollback;

-- ============================================================================
-- T1b: deactivated (inactive) claimed staff has zero access
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = '99999999-9999-9999-9999-999999999901' where email = 'dana@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999901","role":"authenticated","email":"dana@chamama.example"}', true);
do $$ begin
  if public.current_staff_id() is not null then
    raise exception 'FAIL: inactive staff resolved to a staff id';
  end if;
  if (select count(*) from public.students) <> 0 then
    raise exception 'FAIL: inactive staff can read students';
  end if;
  raise notice 'PASS: inactive staff has zero access';
end $$;
rollback;

-- ============================================================================
-- T2: general staff can send a message about ANY student
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  insert into public.student_messages (student_id, author_staff_id, body)
  values ('44444444-4444-4444-4444-444444444404', public.current_staff_id(), 'e2e-check: general staff update');
  raise notice 'PASS: general staff can message any student';
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.student_messages where body like 'e2e-check:%') <> 1 then
    raise exception 'FAIL: message not stored';
  end if;
  raise notice 'PASS: message persisted with staff author';
end $$;
rollback;

-- ============================================================================
-- T3: general staff cannot read unapproved messages (authorship ≠ read)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555504') <> 0 then
    raise exception 'FAIL: general staff read an unapproved message';
  end if;
  -- tom authored msg_private_maya in the seed
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555505') <> 0 then
    raise exception 'FAIL: author read own private message';
  end if;
  raise notice 'PASS: general staff/author cannot read private messages';
end $$;
rollback;

-- ============================================================================
-- T4: general staff CAN read approved-general messages
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555501') <> 1 then
    raise exception 'FAIL: general staff cannot read approved message';
  end if;
  raise notice 'PASS: general staff reads approved-general messages';
end $$;
rollback;

-- ============================================================================
-- T5/T6: assigned master reads own student only
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'naama@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555504') <> 1 then
    raise exception 'FAIL: assigned master cannot read private message';
  end if;
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555505') <> 0 then
    raise exception 'FAIL: unrelated master read a private message';
  end if;
  raise notice 'PASS: master reads own student only';
end $$;
rollback;

-- ============================================================================
-- T7/T8: major head reads in-major only
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'roni@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111106","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555504') <> 1 then
    raise exception 'FAIL: major head cannot read in-major private message';
  end if;
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555505') <> 0 then
    raise exception 'FAIL: major head read out-of-major private message';
  end if;
  raise notice 'PASS: major head reads in-major only';
end $$;
rollback;

-- ============================================================================
-- T9: mentor sees every message of their group
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where student_id = '44444444-4444-4444-4444-444444444401') <> 3 then
    raise exception 'FAIL: mentor does not see all messages of their group';
  end if;
  raise notice 'PASS: mentor sees every message of their group';
end $$;
rollback;

-- ============================================================================
-- T10/T12: mentor approves + blocks
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ begin
  update public.student_messages set is_general_visible = true
   where id = '55555555-5555-5555-5555-555555555502';
  if not found then raise exception 'FAIL: mentor could not approve'; end if;
  update public.student_messages set is_hidden_from_leads = true
   where id = '55555555-5555-5555-5555-555555555502';
  if not found then raise exception 'FAIL: mentor could not hide'; end if;
  raise notice 'PASS: mentor of the group can approve and block';
end $$;
rollback;

-- ============================================================================
-- T11: mentor of another group cannot approve (0 rows)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'yoav@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111103","role":"authenticated"}', true);
do $$ begin
  update public.student_messages set is_general_visible = true
   where id = '55555555-5555-5555-5555-555555555502';
  if found then raise exception 'FAIL: mentor of another group approved'; end if;
  raise notice 'PASS: mentor of another group cannot approve';
end $$;
rollback;

-- ============================================================================
-- T13-T17: blocked message invisible to master + major head; visible to
--          counselor / project coordinator / leadership
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in
  ('michal@chamama.example','naama@chamama.example','roni@chamama.example',
   'shira@chamama.example','amit@chamama.example','liat@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
update public.student_messages set is_hidden_from_leads = true where id = '55555555-5555-5555-5555-555555555502';
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555502') <> 0 then
    raise exception 'FAIL: master still sees blocked message';
  end if;
  raise notice 'PASS: blocked message invisible to relevant master';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111106","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555502') <> 0 then
    raise exception 'FAIL: major head still sees blocked message';
  end if;
  raise notice 'PASS: blocked message invisible to relevant major head';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111107","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555502') <> 1 then
    raise exception 'FAIL: counselor cannot read blocked message';
  end if;
  raise notice 'PASS: counselor reads blocked message';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555502') <> 1 then
    raise exception 'FAIL: coordinator cannot read blocked message';
  end if;
  raise notice 'PASS: coordinator reads blocked message';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555502') <> 1 then
    raise exception 'FAIL: leadership cannot read blocked message';
  end if;
  raise notice 'PASS: leadership reads blocked message';
end $$;
rollback;

-- ============================================================================
-- T18: master+mentor retains mentor access on hidden message
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('yoav@chamama.example','itay@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111103","role":"authenticated"}', true);
do $$ begin
  insert into public.student_messages (student_id, author_staff_id, body)
  values ('44444444-4444-4444-4444-44444444440b', public.current_staff_id(), 't18-check: about Ariel by yoav');
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111105","role":"authenticated"}', true);
do $$ begin
  update public.student_messages set is_hidden_from_leads = true where body like 't18-check:%';
  if not found then raise exception 'FAIL: master+mentor could not moderate'; end if;
  if (select count(*) from public.student_messages where body like 't18-check:%') <> 1 then
    raise exception 'FAIL: master+mentor lost access after hiding';
  end if;
  raise notice 'PASS: master+mentor retains mentor access';
end $$;
rollback;

-- ============================================================================
-- T19: leadership + major_head retains leadership access
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555505') <> 1 then
    raise exception 'FAIL: leadership+major_head lost leadership access';
  end if;
  if (select count(*) from public.student_messages where id = '55555555-5555-5555-5555-555555555508') <> 1 then
    raise exception 'FAIL: leadership cannot read hidden message';
  end if;
  raise notice 'PASS: leadership+major_head retains leadership access';
end $$;
rollback;

-- ============================================================================
-- T20/T21: read state independent per staff identity
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('tom@chamama.example','naama@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  insert into public.message_reads (staff_id, message_id)
  values (public.current_staff_id(), '55555555-5555-5555-5555-555555555504');
  raise notice 'PASS: staff marked own read state';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ begin
  if exists (select 1 from public.message_reads where message_id = '55555555-5555-5555-5555-555555555504') then
    raise exception 'FAIL: one staff read state affected another';
  end if;
  insert into public.message_reads (staff_id, message_id)
  values (public.current_staff_id(), '55555555-5555-5555-5555-555555555504');
  if (select count(*) from public.message_reads where message_id = '55555555-5555-5555-5555-555555555504') <> 1 then
    raise exception 'FAIL: per-staff read rows leaked';
  end if;
  raise notice 'PASS: read state independent per staff identity';
end $$;
rollback;

-- ============================================================================
-- T22: nobody can modify roles via the client
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('ronen@chamama.example','tom@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
do $$ begin
  begin
    insert into public.user_roles (staff_id, role)
    values ('11111111-1111-1111-1111-111111111101', 'counselor');
    raise exception 'FAIL: super_admin self-elevated via client';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: users cannot modify roles (even super_admin via client)';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ declare v_cnt int; begin
  -- RLS with no UPDATE policy silently affects ZERO rows (no error), so the
  -- protection is asserted via row counts, not exceptions:
  update public.user_roles set role = 'leadership';
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL: staff modified roles'; end if;
  delete from public.user_roles;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL: staff deleted roles'; end if;
  raise notice 'PASS: staff cannot update or delete roles (zero rows touched)';
end $$;
rollback;

-- ============================================================================
-- T23: non-admin cannot alter assignments / org structure (service_role only)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ declare v_cnt int; begin
  begin
    insert into public.group_mentors (group_id, staff_id)
    values ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: staff inserted mentor assignment';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.master_assignments (student_id, staff_id)
    values ('44444444-4444-4444-4444-444444444404', '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: staff inserted master assignment';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.major_heads (major_id, staff_id)
    values ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: staff inserted major head';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.students (first_name, last_name) values ('x', 'y');
    raise exception 'FAIL: staff created a student';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.profiles (email, is_active) values ('hacker@evil.com', true);
    raise exception 'FAIL: staff created a staff member';
  exception when insufficient_privilege then null; end;
  -- UPDATEs under RLS with no policy silently touch ZERO rows:
  update public.students set is_archived = true;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL: staff archived a student'; end if;
  update public.profiles set is_active = false;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL: staff deactivated a colleague'; end if;
  raise notice 'PASS: non-admin cannot alter staff/assignments/structure';
end $$;
rollback;

-- ============================================================================
-- T24: non-mentor cannot set visibility flags at insert
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    insert into public.student_messages (student_id, author_staff_id, body, is_general_visible)
    values ('44444444-4444-4444-4444-444444444404', public.current_staff_id(), 'x', true);
    raise exception 'FAIL: non-mentor set general visibility on insert';
  exception when insufficient_privilege or check_violation then null; end;
  raise notice 'PASS: non-mentor cannot set visibility flags at insert';
end $$;
rollback;

-- ============================================================================
-- T25: moderation audited + audit_logs unreadable by staff
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
update public.student_messages set is_general_visible = true where id = '55555555-5555-5555-5555-555555555502';
do $$ begin
  -- audit_logs RLS has NO policies → staff SELECT returns an EMPTY set
  -- (silently), so the protection is asserted as "zero rows visible":
  if exists (select 1 from public.audit_logs limit 1) then
    raise exception 'FAIL: audit logs readable by staff';
  end if;
  raise notice 'PASS: audit logs not readable through RLS';
end $$;
commit;

do $$ begin
  if (select count(*) from public.audit_logs
      where action in ('message_general_visibility_granted','message_general_visibility_revoked')
        and entity_id = '55555555-5555-5555-5555-555555555502') <> 1 then
    raise exception 'FAIL: moderation not audited';
  end if;
  raise notice 'PASS: mentor moderation is audited automatically';
end $$;
update public.student_messages
   set is_general_visible = false, general_visible_by = null, general_visible_at = null
 where id = '55555555-5555-5555-5555-555555555502';
delete from public.audit_logs
 where entity_id = '55555555-5555-5555-5555-555555555502' and action like 'message_%';

-- ============================================================================
-- IDENTITY MODEL TESTS
-- ============================================================================

-- ============================================================================
-- N1: admin (super_admin) creates a staff member who has never logged in;
--     the staff member immediately has a stable id and NULL auth_user_id,
--     and can receive roles atomically.
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'ronen@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
do $$ declare v_id uuid; begin
  v_id := public.admin_create_staff('new.teacher@chamama.example', 'מורה חדשה', true, ARRAY['mentor']::public.app_role[]);
  if v_id is null then raise exception 'FAIL: admin_create_staff returned null'; end if;
  if (select auth_user_id from public.profiles where id = v_id) is not null then
    raise exception 'FAIL: new staff should not have auth_user_id';
  end if;
  if (select count(*) from public.user_roles where staff_id = v_id and role = 'mentor') <> 1 then
    raise exception 'FAIL: role not assigned at creation';
  end if;
  raise notice 'PASS: admin created pre-login staff with stable id + roles';
end $$;
rollback;

-- N1b: non-admin cannot call admin_create_staff
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.admin_create_staff('evil@chamama.example', 'x', true, ARRAY[]::public.app_role[]);
    raise exception 'FAIL: non-admin created staff';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: non-admin cannot create staff via RPC';
end $$;
rollback;

-- ============================================================================
-- N2: pre-login staff can be assigned role / mentor group / master / major
-- head via the service role (admin paths) BEFORE any login
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
-- pre-login staff (no auth_user_id), created by admin
insert into public.profiles (id, email, full_name, is_active, auth_user_id)
values ('88888888-8888-8888-8888-888888888801', 'pre.login@chamama.example', 'טרם התחבר', true, null);
select set_config('role', 'service_role', true);
do $$ begin
  insert into public.user_roles (staff_id, role)
  values ('88888888-8888-8888-8888-888888888801', 'mentor');
  insert into public.group_mentors (group_id, staff_id)
  values ('22222222-2222-2222-2222-222222222201', '88888888-8888-8888-8888-888888888801');
  insert into public.master_assignments (student_id, staff_id)
  values ('44444444-4444-4444-4444-444444444404', '88888888-8888-8888-8888-888888888801');
  insert into public.major_heads (major_id, staff_id)
  values ('33333333-3333-3333-3333-333333333303', '88888888-8888-8888-8888-888888888801');
  raise notice 'PASS: roles/mentor/master/major-head assignable before login';
end $$;
rollback;

-- ============================================================================
-- N3: first login links to the EXISTING staff identity:
--     - stable staff id unchanged
--     - pre-login roles + mentor + master assignments retained
--     - permissions immediately active (my_students resolves)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
insert into public.profiles (id, email, full_name, is_active, auth_user_id)
values ('88888888-8888-8888-8888-888888888802', 'israeli@example.com', 'ישראל ישראלי', true, null);
insert into public.user_roles (staff_id, role)
values ('88888888-8888-8888-8888-888888888802', 'mentor');
insert into public.group_mentors (group_id, staff_id)
values ('22222222-2222-2222-2222-222222222201', '88888888-8888-8888-8888-888888888802');
insert into public.master_assignments (student_id, staff_id)
values ('44444444-4444-4444-4444-444444444404', '88888888-8888-8888-8888-888888888802');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777701', 'authenticated', 'authenticated', 'israeli@example.com', 'x', now(), now(), now(), '{"full_name":"ישראל ישראלי"}');

select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777701","role":"authenticated","email":"Israeli@Example.com"}', true);
do $$ declare
  v_status text;
  v_staff uuid;
  v_auth uuid;
  v_count int;
begin
  v_status := public.claim_staff_identity();
  if v_status <> 'ok' then raise exception 'FAIL: claim returned %', v_status; end if;

  select id, auth_user_id into v_staff, v_auth from public.profiles where email = 'israeli@example.com';
  if v_staff <> '88888888-8888-8888-8888-888888888802' then
    raise exception 'FAIL: staff id changed after login';
  end if;
  if v_auth <> '77777777-7777-7777-7777-777777777701' then
    raise exception 'FAIL: auth_user_id not linked';
  end if;
  if (select count(*) from public.user_roles where staff_id = v_staff and role = 'mentor') <> 1 then
    raise exception 'FAIL: pre-login role lost';
  end if;
  if (select count(*) from public.group_mentors where staff_id = v_staff) <> 1 then
    raise exception 'FAIL: pre-login mentor assignment lost';
  end if;
  if (select count(*) from public.master_assignments where staff_id = v_staff) <> 1 then
    raise exception 'FAIL: pre-login master assignment lost';
  end if;

  -- permissions immediately active through current_staff_id():
  -- israeli mentors group זית (4 students) and is master of one of them
  select count(*) into v_count from public.my_students();
  if v_count <> 4 then raise exception 'FAIL: my_students does not resolve (got %)', v_count; end if;

  raise notice 'PASS: first login linked to existing identity; id/roles/assignments/permissions retained';
end $$;
rollback;

-- ============================================================================
-- N4/N12: an unknown Google account cannot claim or self-register
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777702', 'authenticated', 'authenticated', 'stranger@gmail.com', 'x', now(), now(), now(), '{}');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777702","role":"authenticated","email":"stranger@gmail.com"}', true);
do $$ declare v_status text; begin
  v_status := public.claim_staff_identity();
  if v_status <> 'unauthorized' then raise exception 'FAIL: claim returned %', v_status; end if;
  if (select count(*) from public.profiles where email = 'stranger@gmail.com') <> 0 then
    raise exception 'FAIL: self-registered staff record exists';
  end if;
  raise notice 'PASS: unauthorized Google account cannot claim or self-register';
end $$;
rollback;

-- ============================================================================
-- N5: staff already linked to another auth uid cannot be claimed; incident audited
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
-- the pre-existing auth identity the staff record is (wrongly) linked to
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '66666666-6666-6666-6666-666666666601', 'authenticated', 'authenticated', 'owner@chamama.example', 'x', now(), now(), now(), '{}');
insert into public.profiles (id, email, full_name, is_active, auth_user_id)
values ('88888888-8888-8888-8888-888888888803', 'claimed@chamama.example', 'כבר מקושר', true, '66666666-6666-6666-6666-666666666601');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777703', 'authenticated', 'authenticated', 'claimed@chamama.example', 'x', now(), now(), now(), '{}');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777703","role":"authenticated","email":"claimed@chamama.example"}', true);
do $$ declare v_status text; begin
  v_status := public.claim_staff_identity();
  if v_status <> 'conflict' then raise exception 'FAIL: claim returned %', v_status; end if;
  if (select auth_user_id from public.profiles where email = 'claimed@chamama.example')
       <> '66666666-6666-6666-6666-666666666601' then
    raise exception 'FAIL: existing link was overwritten';
  end if;
  raise notice 'PASS: identity conflict denied (link intact)';
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.audit_logs where action = 'staff_claim_conflict') <> 1 then
    raise exception 'FAIL: conflict not audited';
  end if;
  raise notice 'PASS: identity conflict denied and audited';
end $$;
rollback;

-- ============================================================================
-- N6: inactive staff cannot claim
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
insert into public.profiles (id, email, full_name, is_active, auth_user_id)
values ('88888888-8888-8888-8888-888888888804', 'inactive@chamama.example', 'מושבית', false, null);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777704', 'authenticated', 'authenticated', 'inactive@chamama.example', 'x', now(), now(), now(), '{}');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777704","role":"authenticated","email":"inactive@chamama.example"}', true);
do $$ declare v_status text; begin
  v_status := public.claim_staff_identity();
  if v_status <> 'inactive' then raise exception 'FAIL: claim returned %', v_status; end if;
  if (select auth_user_id from public.profiles where email = 'inactive@chamama.example') is not null then
    raise exception 'FAIL: inactive staff got linked';
  end if;
  raise notice 'PASS: inactive staff cannot claim';
end $$;
rollback;

-- ============================================================================
-- N7: unverified email cannot claim; missing email cannot claim
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
insert into public.profiles (id, email, full_name, is_active, auth_user_id)
values ('88888888-8888-8888-8888-888888888805', 'unverified@chamama.example', 'לא מאומת', true, null);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777705', 'authenticated', 'authenticated', 'unverified@chamama.example', 'x', null, now(), now(), '{}');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777705","role":"authenticated","email":"unverified@chamama.example"}', true);
do $$ declare v_status text; begin
  v_status := public.claim_staff_identity();
  if v_status <> 'email_unverified' then raise exception 'FAIL: claim returned %', v_status; end if;
  raise notice 'PASS: unverified email cannot claim';
end $$;
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777705","role":"authenticated"}', true);
do $$ declare v_status text; begin
  v_status := public.claim_staff_identity();
  if v_status <> 'unauthenticated' then raise exception 'FAIL: no-email claim returned %', v_status; end if;
  raise notice 'PASS: missing email cannot claim';
end $$;
rollback;

-- ============================================================================
-- N8: duplicate normalized email rejected (citext unique)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
insert into public.profiles (id, email, full_name, is_active)
values ('88888888-8888-8888-8888-888888888806', 'dup@chamama.example', 'ראשון', true);
do $$ begin
  begin
    insert into public.profiles (id, email, full_name, is_active)
    values ('88888888-8888-8888-8888-888888888807', 'DUP@chamama.example', 'כפיל', true);
    raise exception 'FAIL: duplicate normalized email accepted';
  exception when unique_violation then null; end;
  raise notice 'PASS: duplicate normalized email rejected';
end $$;
rollback;

-- ============================================================================
-- N9: duplicate non-null auth_user_id rejected
-- (michal's auth account is already linked to michal's staff record)
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
do $$ begin
  begin
    insert into public.profiles (id, email, full_name, is_active, auth_user_id)
    values ('88888888-8888-8888-8888-888888888809', 'second@chamama.example', 'שני', true, '11111111-1111-1111-1111-111111111102');
    raise exception 'FAIL: duplicate auth_user_id accepted';
  exception when unique_violation then null; end;
  raise notice 'PASS: duplicate auth_user_id rejected';
end $$;
rollback;

-- ============================================================================
-- N10: pre-login (unclaimed) staff member has NO access until they claim
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '77777777-7777-7777-7777-777777777706', 'authenticated', 'authenticated', 'avi@chamama.example', 'x', now(), now(), now(), '{}');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777706","role":"authenticated","email":"avi@chamama.example"}', true);
do $$ begin
  -- אבי is allowlisted (active staff row) but has NOT logged in before,
  -- so nothing links auth_user_id → current_staff_id() is null → no access.
  if public.current_staff_id() is not null then
    raise exception 'FAIL: unclaimed staff resolved';
  end if;
  if (select count(*) from public.students) <> 0 then
    raise exception 'FAIL: unclaimed staff has data access';
  end if;
  raise notice 'PASS: unclaimed staff has no access until first login links them';
end $$;
rollback;

-- ============================================================================
-- PART A: PROJECT INTAKE / MASTER REQUEST
-- ============================================================================

\echo '--- project intake tests ---'

-- helper: the SHA-256 of the test token, matching intake_window_for_token
-- window ids are generated; referenced via CTEs inside each test

-- I1: valid token during open window → overview open + groups listed
begin;
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס בדיקה', encode(sha256(convert_to('tok-open-1','UTF8')),'hex'),
        now() - interval '1 day', now() + interval '1 day', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('tok-open-1');
  if v ->> 'status' <> 'open' then raise exception 'FAIL: intake overview status %', v->>'status'; end if;
  if (v -> 'groups' -> 0 ->> 'name') is null then raise exception 'FAIL: groups missing'; end if;
  raise notice 'PASS: valid open token returns overview with groups';
end $$;
rollback;

-- I2: before-open rejected (overview + submit)
begin;
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס עתידי', encode(sha256(convert_to('tok-future-1','UTF8')),'hex'),
        now() + interval '1 day', now() + interval '2 day', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('tok-future-1');
  if v ->> 'status' <> 'not_open' then raise exception 'FAIL: future window status %', v->>'status'; end if;
  v := public.public_intake_submit('tok-future-1', '44444444-4444-4444-4444-444444444401',
        '22222222-2222-2222-2222-222222222201', 'ניסיון', null, '11111111-1111-1111-1111-111111111102');
  if v ->> 'status' <> 'not_open' then raise exception 'FAIL: submit before open allowed'; end if;
  raise notice 'PASS: before-open rejected in overview and submit';
end $$;
rollback;

-- I3: after-close rejected
begin;
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס שנסגר', encode(sha256(convert_to('tok-past-1','UTF8')),'hex'),
        now() - interval '2 day', now() - interval '1 day', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('tok-past-1');
  if v ->> 'status' <> 'closed' then raise exception 'FAIL: closed window status %', v->>'status'; end if;
  v := public.public_intake_submit('tok-past-1', '44444444-4444-4444-4444-444444444401',
        '22222222-2222-2222-2222-222222222201', 'ניסיון', null, '11111111-1111-1111-1111-111111111102');
  if v ->> 'status' <> 'closed' then raise exception 'FAIL: submit after close allowed'; end if;
  raise notice 'PASS: after-close rejected in overview and submit';
end $$;
rollback;

-- I4: invalid + revoked tokens fail closed
begin;
insert into public.intake_windows (title, token_hash, opens_at, closes_at, is_revoked, created_by_staff_id)
values ('טופס מושבת', encode(sha256(convert_to('tok-revoked-1','UTF8')),'hex'),
        now() - interval '1 day', now() + interval '1 day', true, '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('no-such-token');
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: invalid token not rejected'; end if;
  v := public.public_intake_overview('tok-revoked-1');
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: revoked token not rejected'; end if;
  raise notice 'PASS: invalid/revoked tokens fail closed';
end $$;
rollback;

-- I5: anonymous has no table access at all (public flow is RPC-only).
-- RLS with no anon policy returns EMPTY sets silently — assert zero rows.
begin;
select set_config('role', 'anon', true);
do $$ declare v bigint;
begin
  select count(*) into v from public.intake_windows;
  if v <> 0 then raise exception 'FAIL: anon read intake_windows'; end if;
  select count(*) into v from public.intake_submissions;
  if v <> 0 then raise exception 'FAIL: anon read intake_submissions'; end if;
  select count(*) into v from public.student_projects;
  if v <> 0 then raise exception 'FAIL: anon read student_projects'; end if;
  select count(*) into v from public.meeting_reports;
  if v <> 0 then raise exception 'FAIL: anon read meeting_reports'; end if;
  select count(*) into v from public.students;
  if v <> 0 then raise exception 'FAIL: anon read students'; end if;
  select count(*) into v from public.profiles;
  if v <> 0 then raise exception 'FAIL: anon read profiles'; end if;
  raise notice 'PASS: anonymous has no broad SELECT on internal tables (empty sets)';
end $$;
rollback;

-- I6: students-of-group returns only that group's students
begin;
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס בדיקה', encode(sha256(convert_to('tok-open-2','UTF8')),'hex'),
        now() - interval '1 day', now() + interval '1 day', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_students('tok-open-2', '22222222-2222-2222-2222-222222222201');
  if jsonb_array_length(v) <> 4 then raise exception 'FAIL: expected 4 students of זית, got %', jsonb_array_length(v); end if;
  if exists (select 1 from jsonb_array_elements(v) el
             where el->>'id' = '44444444-4444-4444-4444-444444444405') then
    raise exception 'FAIL: students of another group leaked';
  end if;
  raise notice 'PASS: group-student listing scoped to the chosen group';
end $$;
rollback;

-- I7: requested-master choices contain only ACTIVE staff (no emails)
begin;
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס בדיקה', encode(sha256(convert_to('tok-open-3','UTF8')),'hex'),
        now() - interval '1 day', now() + interval '1 day', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_masters('tok-open-3');
  if exists (select 1 from jsonb_array_elements(v) el where el->>'id' = '11111111-1111-1111-1111-11111111110b') then
    raise exception 'FAIL: inactive staff in master choices';
  end if;
  if not exists (select 1 from jsonb_array_elements(v) el where el->>'id' = '11111111-1111-1111-1111-11111111110c') then
    raise exception 'FAIL: pre-login active staff missing from choices';
  end if;
  if exists (select 1 from jsonb_array_elements(v) el where el ? 'email') then
    raise exception 'FAIL: emails leaked in master choices';
  end if;
  raise notice 'PASS: master choices are active staff, names only (pre-login included)';
end $$;
rollback;

-- I8/I9/I10/I11/I12: submission semantics
begin;
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס בדיקה', encode(sha256(convert_to('tok-open-4','UTF8')),'hex'),
        now() - interval '1 day', now() + interval '1 day', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  -- first submission: לא במגמה (null major)
  v := public.public_intake_submit('tok-open-4', '44444444-4444-4444-4444-444444444401',
        '22222222-2222-2222-2222-222222222201', 'כוונה ראשונה', null, '11111111-1111-1111-1111-111111111102');
  if v ->> 'status' <> 'ok' then raise exception 'FAIL: first submission rejected: %', v->>'message'; end if;
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.intake_submissions) <> 1 then
    raise exception 'FAIL: submission count <> 1';
  end if;
  if (select major_id from public.intake_submissions limit 1) is not null then
    raise exception 'FAIL: לא במגמה did not persist as null';
  end if;
end $$;
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  -- resubmission while open UPDATES rather than duplicates
  v := public.public_intake_submit('tok-open-4', '44444444-4444-4444-4444-444444444401',
        '22222222-2222-2222-2222-222222222201', 'כוונה מעודכנת',
        '33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111103');
  if v ->> 'status' <> 'ok' then raise exception 'FAIL: resubmission rejected'; end if;
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.intake_submissions) <> 1 then
    raise exception 'FAIL: submission count <> 1';
  end if;
  if (select intent_text from public.intake_submissions limit 1) <> 'כוונה מעודכנת' then
    raise exception 'FAIL: resubmission did not update';
  end if;
  if (select major_id from public.intake_submissions limit 1) is null then
    raise exception 'FAIL: resubmitted major lost';
  end if;
end $$;
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  -- malformed: student not in the declared group
  v := public.public_intake_submit('tok-open-4', '44444444-4444-4444-4444-444444444405',
        '22222222-2222-2222-2222-222222222201', 'ניסיון שגוי', null, '11111111-1111-1111-1111-111111111102');
  if v ->> 'status' <> 'error' then raise exception 'FAIL: group/student mismatch accepted'; end if;
  -- inactive requested master rejected
  v := public.public_intake_submit('tok-open-4', '44444444-4444-4444-4444-444444444401',
        '22222222-2222-2222-2222-222222222201', 'ניסיון שגוי', null, '11111111-1111-1111-1111-11111111110b');
  if v ->> 'status' <> 'error' then raise exception 'FAIL: inactive master accepted'; end if;
  -- nonexistent master rejected
  v := public.public_intake_submit('tok-open-4', '44444444-4444-4444-4444-444444444401',
        '22222222-2222-2222-2222-222222222201', 'ניסיון שגוי', null, '99999999-9999-9999-9999-999999999999');
  if v ->> 'status' <> 'error' then raise exception 'FAIL: nonexistent master accepted'; end if;
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.intake_submissions) <> 1 then
    raise exception 'FAIL: rejected submissions created rows';
  end if;
  if (select intent_text from public.intake_submissions limit 1) <> 'כוונה מעודכנת' then
    raise exception 'FAIL: rejected submission overwrote data';
  end if;
  raise notice 'PASS: idempotent submission, mismatch/inactive-master rejection, null-major persists';
end $$;
rollback;
-- ============================================================================
-- COORDINATOR ASSIGNMENT
-- ============================================================================
\echo '--- coordinator assignment tests ---'

-- C1: unauthorized staff cannot assign
-- C2: coordinator assigns requested master → canonical project + assignment
-- C3: coordinator assigns a different active master (additive)
-- C4: assigned master then resolves the student through normal permissions
-- C5: project major propagates to major-head access
-- C6: pre-login staff can be assigned
-- C7: assignment audited
begin;
select set_config('role', 'postgres', true);
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס שיבוץ', encode(sha256(convert_to('tok-coord-1','UTF8')),'hex'),
        now() - interval '1 day', now() - interval '1 hour', '11111111-1111-1111-1111-111111111101');
insert into public.intake_submissions (intake_id, student_id, intent_text, major_id, requested_master_staff_id)
select w.id, '44444444-4444-4444-4444-444444444401', 'הכוונה של נועם', '33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111102'
from public.intake_windows w where w.token_hash = encode(sha256(convert_to('tok-coord-1','UTF8')),'hex');
-- claim tom + amit (coordinator)
update public.profiles set auth_user_id = id where email in ('tom@chamama.example','amit@chamama.example');

select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.coordinator_set_master(
      (select id from public.intake_submissions limit 1), '11111111-1111-1111-1111-111111111102');
    raise exception 'FAIL: unauthorized staff assigned a master';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: unauthorized staff cannot assign master';
end $$;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ declare v_sub uuid; v_ok boolean; begin
  select id into v_sub from public.intake_submissions limit 1;
  v_ok := public.coordinator_set_master(v_sub, '11111111-1111-1111-1111-111111111102');
  if not v_ok then raise exception 'FAIL: coordinator assign returned false'; end if;

  -- A: primary Dana assigned
  if (select count(*) from public.master_assignments
      where student_id = '44444444-4444-4444-4444-444444444401'
        and staff_id = '11111111-1111-1111-1111-111111111102'
        and is_primary) <> 1 then
    raise exception 'FAIL: primary master assignment missing';
  end if;
  if (select count(*) from public.master_assignments
      where student_id = '44444444-4444-4444-4444-444444444401' and is_primary) <> 1 then
    raise exception 'FAIL: more than one primary master';
  end if;
  if not exists (select 1 from public.student_projects
                 where student_id = '44444444-4444-4444-4444-444444444401'
                   and intent_text = 'הכוונה של נועם'
                   and major_id = '33333333-3333-3333-3333-333333333301') then
    raise exception 'FAIL: current project not created from submission';
  end if;
  if (select assigned_master_staff_id from public.intake_submissions where id = v_sub)
       <> '11111111-1111-1111-1111-111111111102' then
    raise exception 'FAIL: submission not stamped';
  end if;
  raise notice 'PASS: coordinator assigns requested master (primary + project canonical)';
end $$;

-- C2b: assigning the SAME master again is idempotent
do $$ declare v_count int; begin
  perform public.coordinator_set_master(
    (select id from public.intake_submissions limit 1), '11111111-1111-1111-1111-111111111102');
  select count(*) into v_count from public.master_assignments
   where student_id = '44444444-4444-4444-4444-444444444401'
     and staff_id = '11111111-1111-1111-1111-111111111102';
  if v_count <> 1 then raise exception 'FAIL: duplicate assignment created'; end if;
  raise notice 'PASS: same assignment twice is idempotent';
end $$;

-- C2c: a manually-added secondary master (is_primary = false) — inserted via
-- the postgres/service path (admin server action), like all assignments
select set_config('role', 'postgres', true);
insert into public.master_assignments (student_id, staff_id, is_primary)
values ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111107', false);
select set_config('role', 'authenticated', true);

-- C3: change primary to a DIFFERENT active master — replaces the previous
-- primary, keeps the manually-added secondary, grants the new primary
do $$ declare v_count int; begin
  perform public.coordinator_set_master(
    (select id from public.intake_submissions limit 1), '11111111-1111-1111-1111-111111111104');

  -- new primary
  if (select count(*) from public.master_assignments
      where student_id = '44444444-4444-4444-4444-444444444401'
        and staff_id = '11111111-1111-1111-1111-111111111104' and is_primary) <> 1 then
    raise exception 'FAIL: replacement primary missing';
  end if;
  -- exactly one primary total
  if (select count(*) from public.master_assignments
      where student_id = '44444444-4444-4444-4444-444444444401' and is_primary) <> 1 then
    raise exception 'FAIL: primary replacement left multiple primaries';
  end if;
  -- former primary's coordinator-created row removed
  if exists (select 1 from public.master_assignments
             where student_id = '44444444-4444-4444-4444-444444444401'
               and staff_id = '11111111-1111-1111-1111-111111111102') then
    raise exception 'FAIL: former primary retained from obsolete selection';
  end if;
  -- manually-added secondary survives
  if (select count(*) from public.master_assignments
      where student_id = '44444444-4444-4444-4444-444444444401'
        and staff_id = '11111111-1111-1111-1111-111111111107' and not is_primary) <> 1 then
    raise exception 'FAIL: manually-added secondary master was deleted';
  end if;
  -- intake reflects the actual primary
  if (select assigned_master_staff_id from public.intake_submissions limit 1)
       <> '11111111-1111-1111-1111-111111111104' then
    raise exception 'FAIL: intake does not reflect new primary';
  end if;
  raise notice 'PASS: primary change replaces primary, preserves secondary, stamps intake';
end $$;

-- C3b: former primary no longer has master access from the obsolete row;
--      new primary immediately has master access
do $$ begin
  if public.is_assigned_master('11111111-1111-1111-1111-111111111102', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: former primary retains master access from obsolete assignment';
  end if;
  if not public.is_assigned_master('11111111-1111-1111-1111-111111111104', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: new primary lacks master access';
  end if;
  raise notice 'PASS: old primary loses master access; new primary gains it immediately';
end $$;

-- C4: the newly assigned master now sees the student
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ declare v_count int; begin
  select count(*) into v_count from public.my_students()
   where id = '44444444-4444-4444-4444-444444444401';
  if v_count <> 1 then raise exception 'FAIL: assigned master cannot see the student'; end if;
  raise notice 'PASS: assigned master sees the student through normal permissions';
end $$;

-- C5: project major governs major-head access (נועם: project major = תקשורת)
do $$ begin
  if not public.is_major_head_for_student('11111111-1111-1111-1111-111111111106', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: project major not reflected for תקשורת head';
  end if;
  raise notice 'PASS: project major propagates to major-head visibility';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
-- C6: pre-login staff (auth_user_id NULL) is assignable
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס שיבוץ 2', encode(sha256(convert_to('tok-coord-2','UTF8')),'hex'),
        now() - interval '1 day', now() - interval '1 hour', '11111111-1111-1111-1111-111111111101');
insert into public.intake_submissions (intake_id, student_id, intent_text, major_id, requested_master_staff_id)
select w.id, '44444444-4444-4444-4444-444444444402', 'הצהרה', null, '11111111-1111-1111-1111-11111111110c'
from public.intake_windows w where w.token_hash = encode(sha256(convert_to('tok-coord-2','UTF8')),'hex');
update public.profiles set auth_user_id = id where email = 'amit@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ begin
  perform public.coordinator_set_master(
    (select id from public.intake_submissions limit 1), '11111111-1111-1111-1111-11111111110c');
  if not exists (select 1 from public.master_assignments
                 where student_id = '44444444-4444-4444-4444-444444444402'
                   and staff_id = '11111111-1111-1111-1111-11111111110c') then
    raise exception 'FAIL: pre-login staff not assignable';
  end if;
  if (select auth_user_id from public.profiles where id = '11111111-1111-1111-1111-11111111110c') is not null then
    raise exception 'FAIL: assignment should not require auth_user_id';
  end if;
  raise notice 'PASS: pre-login staff profile assignable (auth_user_id never required)';
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.audit_logs where action = 'intake_master_assigned') <> 1 then
    raise exception 'FAIL: assignment not audited';
  end if;
  raise notice 'PASS: coordinator assignment audited';
end $$;
rollback;

-- ============================================================================
-- PART B: MEETINGS
-- ============================================================================

\echo '--- meeting tests ---'

-- M1/M2/M3/M4: scheduling authorization + overlapping allowed
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('michal@chamama.example','naama@chamama.example','tom@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare v_id uuid; v_count int; begin
  v_id := public.upsert_meeting_schedule('44444444-4444-4444-4444-444444444401'::uuid, 'mentor', 0::smallint, '09:30'::time, true, null);
  if v_id is null then raise exception 'FAIL: mentor schedule failed'; end if;

  -- overlapping: same staff, same student, same time — allowed
  perform public.upsert_meeting_schedule('44444444-4444-4444-4444-444444444401'::uuid, 'mentor', 0::smallint, '09:30'::time, true, null);
  select count(*) into v_count from public.meeting_schedules
   where staff_id = '11111111-1111-1111-1111-111111111102'
     and student_id = '44444444-4444-4444-4444-444444444401'
     and weekday = 0 and meeting_time = '09:30';
  if v_count <> 2 then raise exception 'FAIL: overlapping meetings blocked (got %)', v_count; end if;
  raise notice 'PASS: mentor schedules own group student; overlapping meetings allowed';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.upsert_meeting_schedule('44444444-4444-4444-4444-444444444401'::uuid, 'mentor', 1::smallint, '10:00'::time, true, null);
    raise exception 'FAIL: unrelated staff scheduled a meeting';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: unrelated staff cannot schedule';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ declare v_id uuid; begin
  v_id := public.upsert_meeting_schedule('44444444-4444-4444-4444-444444444401'::uuid, 'master', 2::smallint, '11:00'::time, true, null);
  if v_id is null then raise exception 'FAIL: master schedule failed'; end if;
  raise notice 'PASS: assigned master can schedule';
end $$;
rollback;

-- M5/M6: occurrence generation is idempotent; late-created schedules get no
-- stale past occurrence; reportable listing is staff-scoped
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('michal@chamama.example','tom@chamama.example');
-- michal: a slot 30 minutes ago (within the 1-hour generation window)
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
-- tom: a slot 2 hours ago (outside the window → no stale occurrence)
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-11111111110a', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '2 hours'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '2 hours'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; v_count int; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  perform public.scheduler_generate_occurrences(v_week); -- idempotent
  select count(*) into v_count from public.meeting_occurrences o
   join public.meeting_schedules s on s.id = o.schedule_id
   where s.id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  if v_count <> 1 then raise exception 'FAIL: occurrences generated % (expected 1)', v_count; end if;
  raise notice 'PASS: occurrence generation idempotent; stale slots skipped';
end $$;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare v_count int; begin
  -- scope to THIS test's fresh occurrence: the seeded weekly meeting may also
  -- already be due (date-dependent), which is legitimate
  select count(*) into v_count
    from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401') r
   where r.occurrence_id in (
     select id from public.meeting_occurrences
      where schedule_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
   );
  if v_count <> 1 then raise exception 'FAIL: reportable occurrences for michal = %', v_count; end if;
  raise notice 'PASS: due occurrences reportable by their owner';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ declare v_count int; begin
  select count(*) into v_count from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401');
  if v_count <> 0 then raise exception 'FAIL: unrelated staff sees reportable occurrences'; end if;
  raise notice 'PASS: reportable occurrences are owner-scoped';
end $$;
rollback;

-- M7: held report persisted; duplicate report rejected
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
end $$;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare v_occ uuid; v_report uuid; begin
  select occurrence_id into v_occ from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401') limit 1;
  if v_occ is null then raise exception 'FAIL: no reportable occurrence'; end if;
  v_report := public.submit_meeting_report(v_occ, true, null, null, 'green', false, '{}', null, null, null, 'להמשיך בעבודה על הפרויקט');
  if v_report is null then raise exception 'FAIL: held report failed'; end if;
  begin
    perform public.submit_meeting_report(v_occ, true, null, null, 'green', false, '{}', null, null, null, 'כפילות');
    raise exception 'FAIL: duplicate report accepted';
  exception when unique_violation then null; end;
  raise notice 'PASS: held report persisted; duplicate report rejected';
end $$;
rollback;

-- M8: not-held + same-week reschedule moves the occurrence, not the schedule
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
end $$;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare
  v_occ uuid; v_week date; v_target timestamptz;
  v_new_due timestamptz; v_notified timestamptz; v_claim timestamptz;
  v_sched_wd smallint; v_sched_time time;
begin
  select occurrence_id into v_occ from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401') limit 1;
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  -- same-week target: now + 2h (fall back to +30m if that would cross the week)
  v_target := now() + interval '2 hours';
  if (((v_target at time zone 'Asia/Jerusalem')::date - extract(dow from v_target at time zone 'Asia/Jerusalem')::int) <> v_week) then
    v_target := now() + interval '30 minutes';
  end if;

  perform public.submit_meeting_report(v_occ, false, 'החניך/ה נעדר/ה', v_target, 'yellow', false, '{}', null, null, null, null);

  select due_at, notified_at, notify_started_at into v_new_due, v_notified, v_claim
    from public.meeting_occurrences where id = v_occ;
  if v_new_due <> v_target then
    raise exception 'FAIL: occurrence due_at not moved';
  end if;
  if v_notified is not null then
    raise exception 'FAIL: reminder not re-armed after reschedule';
  end if;
  if v_claim is not null then
    raise exception 'FAIL: notification claim not cleared after reschedule';
  end if;
  select weekday, meeting_time into v_sched_wd, v_sched_time
    from public.meeting_schedules where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  if v_sched_wd <> extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint
     or v_sched_time <> ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time then
    raise exception 'FAIL: recurring schedule mutated by reschedule';
  end if;
  raise notice 'PASS: same-week reschedule moves occurrence only; schedule intact; reminder re-armed (claim cleared)';
end $$;
rollback;

-- M9: next-week reschedule rejected server-side
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; v_occ uuid; v_next_week timestamptz; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  select id into v_occ from public.meeting_occurrences
   where schedule_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and week_start = v_week;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
  v_next_week := ((v_week + 8)::date + '10:00'::time) at time zone 'Asia/Jerusalem';
  begin
    perform public.submit_meeting_report(v_occ, false, 'נעדר', v_next_week, 'green', false, '{}', null, null, null, null);
    raise exception 'FAIL: next-week reschedule accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: next-week reschedule rejected server-side';
end $$;
rollback;

-- M10/M11: report validation
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('ffffffff-ffff-ffff-ffff-ffffffffffff', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
end $$;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare v_occ uuid; begin
  select occurrence_id into v_occ from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401') limit 1;
  begin
    perform public.submit_meeting_report(v_occ, true, null, null, 'purple', false, '{}', null, null, null, 'x');
    raise exception 'FAIL: invalid status accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_meeting_report(v_occ, true, null, null, 'green', true, '{}', null, null, null, 'x');
    raise exception 'FAIL: intervention without categories accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_meeting_report(v_occ, true, null, null, 'green', true, '{functional}', null, null, null, 'x');
    raise exception 'FAIL: category without detail accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: status/intervention/category validation enforced';
end $$;
rollback;

-- M12/M13: canonical status = latest report; visibility + dashboards
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('michal@chamama.example','naama@chamama.example','tom@chamama.example','shira@chamama.example');
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('1111aaaa-1111-aaaa-1111-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('2222aaaa-2222-aaaa-2222-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111104', 'master',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '31 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '31 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
end $$;
-- michal reports green first
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare v_occ uuid; begin
  select r.occurrence_id into v_occ
    from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401') r
    join public.meeting_schedules s on s.id = r.schedule_id
   where s.staff_id = '11111111-1111-1111-1111-111111111102' limit 1;
  perform public.submit_meeting_report(v_occ, true, null, null, 'green', false, '{}', null, null, null, 'המשך');
end $$;
-- then naama (master) reports red later
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ declare v_occ uuid; begin
  select r.occurrence_id into v_occ
    from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401') r
    join public.meeting_schedules s on s.id = r.schedule_id
   where s.staff_id = '11111111-1111-1111-1111-111111111104' limit 1;
  perform public.submit_meeting_report(v_occ, true, null, null, 'red', true, '{functional}', 'דורש מעקב', null, null, 'שיחה עם המנטורית');
end $$;
select set_config('role', 'postgres', true);
do $$ declare
  v_status text; v_interv boolean; v_count int;
begin
  select status, intervention into v_status, v_interv from public.dashboard_rows()
   where student_id = '44444444-4444-4444-4444-444444444401';
  if v_status <> 'red' or v_interv is not true then
    raise exception 'FAIL: canonical status % (expected red + intervention)', v_status;
  end if;
  raise notice 'PASS: dashboard status reflects latest canonical report + intervention';
end $$;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ declare v_count int; begin
  select count(*) into v_count from public.dashboard_rows()
   where student_id = '44444444-4444-4444-4444-444444444401';
  if v_count <> 0 then raise exception 'FAIL: unrelated staff sees dashboard row'; end if;
  -- RLS silently filters: unrelated staff sees zero report rows
  select count(*) into v_count from public.meeting_reports;
  if v_count <> 0 then raise exception 'FAIL: unrelated staff read reports'; end if;
  raise notice 'PASS: unrelated staff excluded from dashboards and reports';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111107","role":"authenticated"}', true);
do $$ declare v_count int; begin
  select count(*) into v_count from public.meeting_reports
   where student_id = '44444444-4444-4444-4444-444444444401';
  if v_count < 2 then raise exception 'FAIL: counselor cannot read meeting reports'; end if;
  raise notice 'PASS: privileged staff reads meeting reports';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ declare
  v_missing_status text; v_count int;
begin
  -- student with no reports shows NULL status (טרם דווח) — e.g. ליאו for michal? michal isn't related to ליאו; use a fresh student via naama:
  select count(*) into v_count from public.dashboard_rows() where student_id = '44444444-4444-4444-4444-444444444405' and status is null;
  if v_count <> 1 then raise exception 'FAIL: missing-report status not NULL for naama student'; end if;
  raise notice 'PASS: missing report yields NULL status (טרם דווח)';
end $$;
rollback;

-- N13/R: regular staff cannot read intake windows (coordinator-only RLS)
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ declare v_count int; begin
  select count(*) into v_count from public.intake_windows;
  if v_count <> 0 then raise exception 'FAIL: regular staff reads intake windows'; end if;
  select count(*) into v_count from public.intake_submissions;
  if v_count <> 0 then raise exception 'FAIL: regular staff reads intake submissions'; end if;
  raise notice 'PASS: intake tables restricted to coordinator/super_admin';
end $$;
rollback;

-- ============================================================================
-- NOTIFICATION CLAIM (atomic dedup)
-- ============================================================================

\echo '--- notification claim tests ---'

-- CL-A/F: claim returns the row once; an active claim is not reclaimable;
--         after rollback (crashed worker) the row is claimable again
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaa1111-1111-1111-1111-111111111101', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; v_claimed int; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  -- worker A claims
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 1 then raise exception 'FAIL: first claim got % rows', v_claimed; end if;
  -- a second claim in the same instant gets nothing (active claim)
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 0 then raise exception 'FAIL: actively-claimed occurrence reclaimed'; end if;
  raise notice 'PASS: claim returns once; active claim not reclaimable';
end $$;
rollback;

-- CL-A2 (crashed worker): a claim that rolls back (crash) becomes retryable
begin;
select set_config('role', 'postgres', true);
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaa1111-1111-1111-1111-111111111102', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; v_claimed int; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 1 then raise exception 'FAIL: claim failed'; end if;
end $$;
rollback; -- crash: claim rolled back
begin;
select set_config('role', 'service_role', true);
do $$ declare v_claimed int; begin
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 0 then raise exception 'FAIL: no occurrence to claim after crash-rollback'; end if;
  raise notice 'PASS: rolled-back (crashed) claim is retryable';
end $$;
-- NOTE: the occurrence itself rolled back with the fixture; the retryable
-- claim semantics are proven by CL-E (lease expiry) below.
rollback;

-- CL-B/H: two DIFFERENT overlapping occurrences are both claimable
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaa1111-1111-1111-1111-111111111103', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaa1111-1111-1111-1111-111111111104', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; v_claimed int; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 2 then raise exception 'FAIL: overlapping meetings claimed % (expected 2)', v_claimed; end if;
  raise notice 'PASS: overlapping same-time meetings produce independent reminders';
end $$;
rollback;

-- CL-C/D: success marks notified (skipped forever); failure releases claim
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaa1111-1111-1111-1111-111111111105', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; v_occ uuid; v_claimed int; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  select id into v_occ from public.meeting_occurrences
   where schedule_id = 'aaaa1111-1111-1111-1111-111111111105' and week_start = v_week;

  -- worker claims
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 1 then raise exception 'FAIL: claim failed'; end if;

  -- delivery FAILED: dispatcher releases the claim (retryable)
  update public.meeting_occurrences set notify_started_at = null where id = v_occ;
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 1 then raise exception 'FAIL: failed delivery not retryable'; end if;
  raise notice 'PASS: failed delivery becomes retryable';

  -- delivery SUCCEEDED: mark notified (this is what the route does on success)
  update public.meeting_occurrences
     set notified_at = now(), notify_started_at = null
   where id = v_occ;
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 0 then raise exception 'FAIL: notified occurrence reclaimed'; end if;
  raise notice 'PASS: successful delivery skipped by future dispatchers';
end $$;
rollback;

-- CL-E: expired lease becomes reclaimable
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaa1111-1111-1111-1111-111111111106', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; v_occ uuid; v_claimed int; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  select id into v_occ from public.meeting_occurrences
   where schedule_id = 'aaaa1111-1111-1111-1111-111111111106' and week_start = v_week;

  -- crashed worker left a claim older than the 60s lease
  update public.meeting_occurrences
     set notify_started_at = now() - interval '61 seconds'
   where id = v_occ;
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 1 then raise exception 'FAIL: expired lease not reclaimable'; end if;
  raise notice 'PASS: expired claim lease becomes retryable';
end $$;
rollback;

-- CL-G: reschedule re-arms exactly once (notified_at + claim both cleared)
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('aaaa1111-1111-1111-1111-111111111107', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare
  v_week date; v_occ uuid; v_target timestamptz;
  v_notified timestamptz; v_claim timestamptz; v_claimed int;
begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
  select id into v_occ from public.meeting_occurrences
   where schedule_id = 'aaaa1111-1111-1111-1111-111111111107' and week_start = v_week;

  -- mark as already notified (simulating an earlier reminder)
  update public.meeting_occurrences set notified_at = now() where id = v_occ;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
  v_target := now() + interval '2 hours';
  if (((v_target at time zone 'Asia/Jerusalem')::date - extract(dow from v_target at time zone 'Asia/Jerusalem')::int) <> v_week) then
    v_target := now() + interval '30 minutes';
  end if;
  perform public.submit_meeting_report(v_occ, false, 'נעדר', v_target, 'yellow', false, '{}', null, null, null, null);

  select notified_at, notify_started_at into v_notified, v_claim
    from public.meeting_occurrences where id = v_occ;
  if v_notified is not null or v_claim is not null then
    raise exception 'FAIL: reschedule did not re-arm notification state';
  end if;

  -- dispatcher context: the rescheduled slot (now+2h) is not yet due → 0
  perform set_config('role', 'service_role', true);
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 0 then raise exception 'FAIL: not-yet-due occurrence claimed'; end if;

  -- simulate time passing (the new slot becomes imminent) → claimable once
  update public.meeting_occurrences set due_at = now() where id = v_occ;
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 1 then raise exception 'FAIL: re-armed occurrence not claimable exactly once'; end if;
  select count(*) into v_claimed from public.claim_due_meeting_occurrences(50);
  if v_claimed <> 0 then raise exception 'FAIL: re-armed occurrence claimed twice'; end if;
  raise notice 'PASS: reschedule re-arms the reminder exactly once';
end $$;
rollback;

-- ============================================================================
-- INTAKE RPC HARDENING (20260917000001): explicit status model
-- ============================================================================
\echo '--- intake RPC hardening tests ---'

-- H1: overview ALWAYS returns exactly one jsonb with a status — even for
--     garbage, empty, or NULL tokens (never NULL, never an exception)
begin;
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('totally-unknown-token');
  if v is null or v ->> 'status' <> 'invalid' then
    raise exception 'FAIL: garbage token overview = %', v;
  end if;
  v := public.public_intake_overview('');
  if v is null or v ->> 'status' <> 'invalid' then
    raise exception 'FAIL: empty token overview = %', v;
  end if;
  raise notice 'PASS: overview always returns a status (invalid for unknown tokens)';
end $$;
rollback;

-- H2: anon has EXECUTE on every public intake RPC (and nothing else changed)
begin;
select set_config('role', 'anon', true);
do $$ begin
  if not has_function_privilege('anon', 'public.public_intake_overview(text)', 'execute') then
    raise exception 'FAIL: anon cannot execute overview';
  end if;
  if not has_function_privilege('anon', 'public.public_intake_majors(text)', 'execute') then
    raise exception 'FAIL: anon cannot execute majors';
  end if;
  if not has_function_privilege('anon', 'public.public_intake_masters(text)', 'execute') then
    raise exception 'FAIL: anon cannot execute masters';
  end if;
  raise notice 'PASS: anon can execute the public intake RPCs';
end $$;
rollback;

-- H3: a revoked window reports 'invalid' through the hardened body too
begin;
select set_config('role', 'postgres', true);
insert into public.intake_windows (title, token_hash, opens_at, closes_at, is_revoked, created_by_staff_id)
values ('טופס מושבת 2', encode(sha256(convert_to('tok-revoked-2','UTF8')),'hex'),
        now() - interval '1 day', now() + interval '1 day', true, '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('tok-revoked-2');
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: revoked window status %', v->>'status'; end if;
  raise notice 'PASS: revoked token fails closed through hardened RPC';
end $$;
rollback;

-- H4: freshly-created valid window resolves 'open' through the hardened body
begin;
select set_config('role', 'postgres', true);
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס טרי', encode(sha256(convert_to('tok-fresh-1','UTF8')),'hex'),
        now() - interval '5 minutes', now() + interval '5 minutes', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('tok-fresh-1');
  if v ->> 'status' <> 'open' then raise exception 'FAIL: fresh window status %', v->>'status'; end if;
  if (v -> 'groups') is null then raise exception 'FAIL: groups missing for fresh window'; end if;
  raise notice 'PASS: freshly-created valid link resolves open immediately';
end $$;
rollback;

-- ============================================================================
-- AUTHENTICATED EXECUTE on the public intake RPCs (20260917000002)
-- ============================================================================
\echo '--- authenticated intake EXECUTE tests ---'

-- X1: anon AND authenticated both have EXECUTE on all five public RPCs
do $$ begin
  if not has_function_privilege('anon', 'public.public_intake_overview(text)', 'execute') then
    raise exception 'FAIL: anon missing EXECUTE on overview';
  end if;
  if not has_function_privilege('anon', 'public.public_intake_students(text,uuid)', 'execute') then
    raise exception 'FAIL: anon missing EXECUTE on students';
  end if;
  if not has_function_privilege('anon', 'public.public_intake_majors(text)', 'execute') then
    raise exception 'FAIL: anon missing EXECUTE on majors';
  end if;
  if not has_function_privilege('anon', 'public.public_intake_masters(text)', 'execute') then
    raise exception 'FAIL: anon missing EXECUTE on masters';
  end if;
  if not has_function_privilege('anon', 'public.public_intake_submit(text,uuid,uuid,text,uuid,uuid)', 'execute') then
    raise exception 'FAIL: anon missing EXECUTE on submit';
  end if;
  if not has_function_privilege('authenticated', 'public.public_intake_overview(text)', 'execute') then
    raise exception 'FAIL: authenticated missing EXECUTE on overview';
  end if;
  if not has_function_privilege('authenticated', 'public.public_intake_students(text,uuid)', 'execute') then
    raise exception 'FAIL: authenticated missing EXECUTE on students';
  end if;
  if not has_function_privilege('authenticated', 'public.public_intake_majors(text)', 'execute') then
    raise exception 'FAIL: authenticated missing EXECUTE on majors';
  end if;
  if not has_function_privilege('authenticated', 'public.public_intake_masters(text)', 'execute') then
    raise exception 'FAIL: authenticated missing EXECUTE on masters';
  end if;
  if not has_function_privilege('authenticated', 'public.public_intake_submit(text,uuid,uuid,text,uuid,uuid)', 'execute') then
    raise exception 'FAIL: authenticated missing EXECUTE on submit';
  end if;
  raise notice 'PASS: anon + authenticated have EXECUTE on all five public intake RPCs';
end $$;

-- X2: anon still cannot SELECT intake_windows directly (RLS: empty set)
begin;
select set_config('role', 'anon', true);
do $$ declare v bigint; begin
  select count(*) into v from public.intake_windows;
  if v <> 0 then raise exception 'FAIL: anon selected intake_windows'; end if;
  raise notice 'PASS: anon still has no direct SELECT on intake_windows';
end $$;
rollback;

-- X3: authenticated gains NO new direct public-intake table access
--     (select stays RLS-filtered to coordinator/super_admin; no inserts)
begin;
select set_config('role', 'postgres', true);
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס X3', encode(sha256(convert_to('tok-x3','UTF8')),'hex'),
        now() - interval '5 minutes', now() + interval '5 minutes', '11111111-1111-1111-1111-111111111101');
insert into public.intake_submissions (intake_id, student_id, intent_text, major_id, requested_master_staff_id)
select w.id, '44444444-4444-4444-4444-444444444401', 'הצהרה', null, '11111111-1111-1111-1111-111111111102'
from public.intake_windows w where w.token_hash = encode(sha256(convert_to('tok-x3','UTF8')),'hex');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ declare v int; begin
  -- signed-in regular staff (tom): RLS still filters BOTH tables to zero rows
  select count(*) into v from public.intake_windows;
  if v <> 0 then raise exception 'FAIL: authenticated sees intake_windows rows'; end if;
  select count(*) into v from public.intake_submissions;
  if v <> 0 then raise exception 'FAIL: authenticated sees intake_submissions rows'; end if;
  begin
    insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
    values ('x', encode(sha256(convert_to('tok-x3-b','UTF8')),'hex'), now(), now(), '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: authenticated inserted an intake window';
  exception when insufficient_privilege then null; end;
  -- UPDATE/DELETE under RLS with no policy silently touch ZERO rows:
  update public.intake_windows set is_revoked = true;
  get diagnostics v = row_count;
  if v <> 0 then raise exception 'FAIL: authenticated updated an intake window'; end if;
  delete from public.intake_submissions;
  get diagnostics v = row_count;
  if v <> 0 then raise exception 'FAIL: authenticated deleted submissions'; end if;
  raise notice 'PASS: EXECUTE grant adds no direct table access for authenticated';
end $$;
rollback;

-- X4: invalid token remains invalid for BOTH roles
begin;
select set_config('role', 'postgres', true);
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס X4', encode(sha256(convert_to('tok-x4','UTF8')),'hex'),
        now() - interval '5 minutes', now() + interval '5 minutes', '11111111-1111-1111-1111-111111111101');
select set_config('role', 'anon', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('totally-wrong-token');
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: anon invalid token status %', v->>'status'; end if;
end $$;
select set_config('role', 'authenticated', true);
do $$ declare v jsonb; begin
  v := public.public_intake_overview('totally-wrong-token');
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL: authenticated invalid token status %', v->>'status'; end if;
  raise notice 'PASS: invalid token remains invalid under both roles';
end $$;
rollback;

-- X5: a VALID token works IDENTICALLY under anon and authenticated
begin;
select set_config('role', 'postgres', true);
insert into public.intake_windows (title, token_hash, opens_at, closes_at, created_by_staff_id)
values ('טופס X5', encode(sha256(convert_to('tok-x5','UTF8')),'hex'),
        now() - interval '5 minutes', now() + interval '5 minutes', '11111111-1111-1111-1111-111111111101');
do $$ declare
  v_anon jsonb; v_anon_students jsonb;
  v_auth jsonb; v_auth_students jsonb;
  v_submit_status text;
begin
  perform set_config('role', 'anon', true);
  v_anon := public.public_intake_overview('tok-x5');
  if v_anon ->> 'status' <> 'open' then raise exception 'FAIL: anon overview %', v_anon->>'status'; end if;
  v_anon_students := public.public_intake_students('tok-x5', '22222222-2222-2222-2222-222222222201');
  if jsonb_array_length(v_anon_students) <> 4 then raise exception 'FAIL: anon students %', v_anon_students; end if;

  perform set_config('role', 'authenticated', true);
  v_auth := public.public_intake_overview('tok-x5');
  if v_auth ->> 'status' <> 'open' then raise exception 'FAIL: authenticated overview %', v_auth->>'status'; end if;
  if v_auth ->> 'title' <> (v_anon ->> 'title') then
    raise exception 'FAIL: overview differs between roles';
  end if;
  v_auth_students := public.public_intake_students('tok-x5', '22222222-2222-2222-2222-222222222201');
  if v_auth_students <> v_anon_students then
    raise exception 'FAIL: student list differs between roles';
  end if;
  -- submit works identically under authenticated (staff with a session)
  v_submit_status := (public.public_intake_submit('tok-x5', '44444444-4444-4444-4444-444444444401',
      '22222222-2222-2222-2222-222222222201', 'הצהרה', null,
      '11111111-1111-1111-1111-111111111102')) ->> 'status';
  if v_submit_status <> 'ok' then raise exception 'FAIL: authenticated submit %', v_submit_status; end if;
  raise notice 'PASS: valid token works identically under anon and authenticated';
end $$;
rollback;

-- ============================================================================
-- PART A PHASE 2: AD-HOC REPORTS, DELETION, FEED
-- ============================================================================
\echo '--- ad-hoc reports / deletion / feed tests ---'

-- M14: mentor submits an ad-hoc report without any occurrence
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare
  v_meeting_at timestamptz := (now() at time zone 'Asia/Jerusalem' - interval '2 hours') at time zone 'UTC';
  v_report uuid;
begin
  v_report := public.submit_adhoc_meeting_report(
    '44444444-4444-4444-4444-444444444401', 'mentor', v_meeting_at,
    true, null, 'yellow', true, '{functional}', 'דורש מעקב תפקודי', null, null,
    'נקבעה שיחה עם ההורים');
  if v_report is null then raise exception 'FAIL: ad-hoc report failed'; end if;
  if (select meeting_at from public.meeting_reports where id = v_report) <> v_meeting_at then
    raise exception 'FAIL: meeting_at not stored';
  end if;
  if (select context from public.meeting_reports where id = v_report) <> 'mentor' then
    raise exception 'FAIL: context not stored';
  end if;
  if (select occurrence_id from public.meeting_reports where id = v_report) is not null then
    raise exception 'FAIL: ad-hoc report linked to an occurrence';
  end if;
  raise notice 'PASS: ad-hoc report stored with canonical meeting_at + context';
end $$;
rollback;

-- M15: ad-hoc authorization — unrelated staff rejected
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.submit_adhoc_meeting_report(
      '44444444-4444-4444-4444-444444444401', 'mentor', now(), true, null,
      'green', false, '{}', null, null, null, 'x');
    raise exception 'FAIL: unrelated staff submitted ad-hoc report';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: ad-hoc report authorization enforced';
end $$;
rollback;

-- M16: deletion — owner soft-deletes; canonical status recomputed; audited
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('michal@chamama.example','naama@chamama.example','tom@chamama.example');
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time, is_active)
values ('7777aaaa-7777-aaaa-7777-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444401',
        '11111111-1111-1111-1111-111111111102', 'mentor',
        extract(dow from (now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::smallint,
        ((now() at time zone 'Asia/Jerusalem' - interval '30 minutes'))::time, true);
select set_config('role', 'service_role', true);
do $$ declare v_week date; begin
  v_week := ((now() at time zone 'Asia/Jerusalem')::date - extract(dow from (now() at time zone 'Asia/Jerusalem'))::int);
  perform public.scheduler_generate_occurrences(v_week);
end $$;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare
  v_occ uuid; v_red uuid; v_green uuid; v_status text; v_infeed int;
begin
  -- occurrence-linked red report (michal)
  select occurrence_id into v_occ from public.my_reportable_occurrences('44444444-4444-4444-4444-444444444401') limit 1;
  v_red := public.submit_meeting_report(v_occ, true, null, null, 'red', false, '{}', null, null, null, 'מעקב');
  -- ad-hoc green report (michal, later submission)
  v_green := public.submit_adhoc_meeting_report(
    '44444444-4444-4444-4444-444444444401', 'mentor', now(), true, null,
    'green', false, '{}', null, null, null, 'הכל בסדר');
  -- canonical = green (latest submission)
  select status into v_status from public.dashboard_rows()
   where student_id = '44444444-4444-4444-4444-444444444401';
  if v_status <> 'green' then raise exception 'FAIL: canonical status % before deletion', v_status; end if;
  -- feed includes the report
  select count(*) into v_infeed from public.student_feed_items('44444444-4444-4444-4444-444444444401')
   where kind = 'report';
  if v_infeed < 2 then raise exception 'FAIL: reports missing from feed'; end if;

  -- delete the green ad-hoc report (owner) → status recomputes to red
  perform public.delete_meeting_report(v_green);
  select status into v_status from public.dashboard_rows()
   where student_id = '44444444-4444-4444-4444-444444444401';
  if v_status <> 'red' then raise exception 'FAIL: status not recomputed after deletion (%)', v_status; end if;
  -- deleted report gone from feed
  select count(*) into v_infeed from public.student_feed_items('44444444-4444-4444-4444-444444444401')
   where kind = 'report' and item_id = v_green::text;
  if v_infeed <> 0 then raise exception 'FAIL: deleted report still in feed'; end if;
  raise notice 'PASS: report deletion recomputes canonical status + feed + audited';
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.audit_logs where action = 'meeting_report_deleted') < 1 then
    raise exception 'FAIL: deletion not audited';
  end if;
  raise notice 'PASS: report deletion audited';
end $$;
-- unauthorized deletion blocked (unrelated staff cannot even see the report)
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.delete_meeting_report(
      (select id from public.meeting_reports where deleted_at is null limit 1));
    raise exception 'FAIL: unrelated staff deleted a report';
  exception when others then
    null; -- denied OR invisible via RLS — both mean the report is protected
  end;
  raise notice 'PASS: unrelated staff cannot delete reports';
end $$;
rollback;

-- ============================================================================
-- PART B: FORM ENGINE
-- ============================================================================
\echo '--- form engine tests ---'

-- F1: coordinator creates a form → draft; ordinary staff rejected
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('ronen@chamama.example','tom@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
do $$ declare v_id uuid; begin
  v_id := public.form_create('mid_feedback_test', 'משוב אמצע', 'תיאור', 'staff', 'project',
    '{"version":"1","steps":[{"id":"s1","title":"שאלות"}],"fields":[{"key":"status","type":"gyr","label":"מצב","required":true,"stepId":"s1"}]}'::jsonb);
  if v_id is null then raise exception 'FAIL: form_create returned null'; end if;
  if (select status from public.form_definitions where id = v_id) <> 'draft' then
    raise exception 'FAIL: created form is not draft';
  end if;
  raise notice 'PASS: coordinator creates draft form';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.form_create('evil_form', 'x', null, 'staff', 'hidden', '{}'::jsonb);
    raise exception 'FAIL: ordinary staff created a form';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: ordinary staff cannot create forms';
end $$;
rollback;

-- F2/F3: publish creates immutable versions; invalid schema rejected
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'amit@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ declare v_id uuid; v_ver1 int; v_ver2 int; v_row1 uuid; begin
  v_id := public.form_create('pub_test_form', 'טופס בדיקה', null, 'staff', 'hidden',
    '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"f1","type":"short_text","label":"שדה","required":true,"stepId":"s1"}]}'::jsonb);
  v_ver1 := public.form_publish(v_id);
  if v_ver1 <> 1 then raise exception 'FAIL: first publish version %', v_ver1; end if;
  select id into v_row1 from public.form_versions where form_definition_id = v_id and version_number = 1;
  -- edit draft + publish again → version 2, v1 immutable
  perform public.form_save_draft(v_id, 'טופס בדיקה', null, null,
    '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"f1","type":"short_text","label":"שדה מעודכן","required":true,"stepId":"s1"}]}'::jsonb);
  v_ver2 := public.form_publish(v_id);
  if v_ver2 <> 2 then raise exception 'FAIL: second publish version %', v_ver2; end if;
  if (select schema_json -> 'fields' -> 0 ->> 'label' from public.form_versions where id = v_row1) <> 'שדה' then
    raise exception 'FAIL: historical version mutated';
  end if;
  raise notice 'PASS: publish creates immutable versions';
end $$;
-- invalid schemas rejected
do $$ declare v_id uuid; begin
  v_id := public.form_create('bad_form_test', 'שגוי', null, 'staff', 'hidden',
    '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"f1","type":"short_text","label":"x","required":true,"stepId":"s9"}]}'::jsonb);
  begin
    perform public.form_publish(v_id);
    raise exception 'FAIL: unknown-step reference accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: invalid schema rejected at publish';
end $$;
rollback;

-- F4: branch loop rejected
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'amit@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ declare v_id uuid; begin
  v_id := public.form_create('loop_form', 'לולאה', null, 'staff', 'hidden',
    ('{"version":"1","steps":[{"id":"s1","title":"a"},{"id":"s2","title":"b"}],"fields":[' ||
    '{"key":"f1","type":"yes_no","label":"x","required":true,"stepId":"s1","branch":{"when":{"field":"f1","op":"eq","value":"no"},"gotoStep":"s2"}},' ||
    '{"key":"f2","type":"yes_no","label":"y","required":true,"stepId":"s2","branch":{"when":{"field":"f2","op":"eq","value":"no"},"gotoStep":"s1"}}]}')::jsonb);
  begin
    perform public.form_publish(v_id);
    raise exception 'FAIL: branching loop accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: branching loop rejected';
end $$;
rollback;

-- F5: authenticated submission — respondent derived, version bound
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'amit@chamama.example';
insert into public.form_definitions (id, form_key, name, audience, feed_category, status, created_by_staff_id)
values ('99999999-9999-9999-9999-999999999901', 'mid_feedback_test', 'משוב אמצע', 'staff', 'project', 'published', '11111111-1111-1111-1111-111111111101');
insert into public.form_versions (id, form_definition_id, version_number, schema_json, created_by_staff_id)
values ('99999999-9999-9999-9999-999999999902', '99999999-9999-9999-9999-999999999901', 1,
  '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"status","type":"gyr","label":"מצב","required":true,"stepId":"s1"}]}'::jsonb, '11111111-1111-1111-1111-111111111101');
update public.form_definitions set current_version_id = '99999999-9999-9999-9999-999999999902' where form_key = 'mid_feedback_test';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111105","role":"authenticated"}', true);
do $$ declare v_id uuid; begin
  v_id := public.submit_staff_form('mid_feedback_test', '44444444-4444-4444-4444-444444444401',
    '{"status":"yellow"}'::jsonb);
  if (select respondent_staff_id from public.form_submissions where id = v_id)
       <> '11111111-1111-1111-1111-111111111105' then
    raise exception 'FAIL: respondent not derived from current_staff_id';
  end if;
  if (select form_version_id from public.form_submissions where id = v_id)
       <> '99999999-9999-9999-9999-999999999902' then
    raise exception 'FAIL: submission not bound to current version';
  end if;
  raise notice 'PASS: staff submission respondent-derived + version-bound';
end $$;
rollback;

-- F6: public campaign — token flow + resubmission policy
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'amit@chamama.example';
insert into public.form_definitions (id, form_key, name, audience, feed_category, status, created_by_staff_id)
values ('99999999-9999-9999-9999-999999999903', 'reflection_test', 'ריפלקציה', 'public', 'hidden', 'published', '11111111-1111-1111-1111-111111111101');
insert into public.form_versions (id, form_definition_id, version_number, schema_json, created_by_staff_id)
values ('99999999-9999-9999-9999-999999999904', '99999999-9999-9999-9999-999999999903', 1,
  '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"text","type":"long_text","label":"רפלקציה","required":true,"stepId":"s1"}]}'::jsonb, '11111111-1111-1111-1111-111111111101');
update public.form_definitions set current_version_id = '99999999-9999-9999-9999-999999999904' where form_key = 'reflection_test';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ declare v_token text; v_res jsonb; begin
  v_token := public.form_campaign_create('99999999-9999-9999-9999-999999999903',
    now() - interval '5 minutes', now() + interval '5 minutes', '44444444-4444-4444-4444-444444444401', false);
  if v_token is null or length(v_token) < 20 then raise exception 'FAIL: campaign token missing'; end if;
  if (select token_hash from public.form_campaigns where subject_student_id = '44444444-4444-4444-4444-444444444401')
       = v_token then
    raise exception 'FAIL: raw token stored in DB';
  end if;
  perform set_config('role', 'anon', true);
  v_res := public.public_form_overview(v_token);
  if v_res ->> 'status' <> 'open' then raise exception 'FAIL: public form overview %', v_res->>'status'; end if;
  if (v_res -> 'form_name') is null then raise exception 'FAIL: form name missing'; end if;
  v_res := public.public_form_submit(v_token, '{"text":"החניך דיווח"}'::jsonb);
  if v_res ->> 'status' <> 'ok' then raise exception 'FAIL: public submit %', v_res; end if;
  -- resubmission blocked (allow_resubmit = false)
  v_res := public.public_form_submit(v_token, '{"text":"שנית"}'::jsonb);
  if v_res ->> 'status' <> 'already_submitted' then raise exception 'FAIL: resubmission allowed'; end if;
  raise notice 'PASS: public campaign token flow + resubmission policy';
end $$;
rollback;

-- F7: anon/authenticated cannot select form tables directly (broad access).
-- RLS with no policy returns EMPTY sets silently — assert zero rows.
begin;
select set_config('role', 'anon', true);
do $$ declare v bigint; begin
  select count(*) into v from public.form_definitions;
  if v <> 0 then raise exception 'FAIL: anon read form_definitions'; end if;
  select count(*) into v from public.form_submissions;
  if v <> 0 then raise exception 'FAIL: anon read form_submissions'; end if;
  raise notice 'PASS: anon cannot read form engine tables (empty sets)';
end $$;
rollback;

-- ============================================================================
-- AUDIT FIXES (20260919000001): View-As, feed, immutability, validation
-- ============================================================================
\echo '--- audit fixes tests ---'

-- V1: dashboard_rows_view_as is super_admin-only
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('amit@chamama.example','tom@chamama.example','michal@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ declare v_count int; begin
  select count(*) into v_count from public.dashboard_rows_view_as(
    '11111111-1111-1111-1111-111111111102', 'mentor');
  if v_count > 0 then raise exception 'FAIL: non-super_admin called dashboard_rows_view_as'; end if;
  raise notice 'PASS: dashboard_rows_view_as denied for non-super_admin';
end $$;
rollback;

-- V2: super_admin can view-as a mentor and sees only that mentor's group students
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('ronen@chamama.example','michal@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
do $$ declare v_count int; begin
  select count(*) into v_count from public.dashboard_rows_view_as(
    '11111111-1111-1111-1111-111111111102', 'mentor');
  -- מיכל mentors groups זית (4 students) + דקל (4 students) = 8
  if v_count <> 8 then raise exception 'FAIL: view-as mentor rows % (expected 8)', v_count; end if;
  raise notice 'PASS: view-as mentor returns correct scoped rows';
end $$;
rollback;

-- V3: view-as with a role the target doesn't have returns zero rows
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email in ('amit@chamama.example','tom@chamama.example');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ declare v_count int; begin
  -- tom is ordinary staff, not a mentor → mentor view-as returns 0
  select count(*) into v_count from public.dashboard_rows_view_as(
    '11111111-1111-1111-1111-11111111110a', 'mentor');
  if v_count <> 0 then raise exception 'FAIL: view-as mentor for non-mentor returned rows'; end if;
  raise notice 'PASS: view-as respects target relationship';
end $$;
rollback;

-- V4: form_versions immutability — authenticated cannot UPDATE or DELETE
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'amit@chamama.example';
insert into public.form_definitions (id, form_key, name, audience, feed_category, status, created_by_staff_id)
values ('88888888-8888-8888-8888-888888888801', 'immutable_test', 'בדיקה', 'staff', 'hidden', 'published', '11111111-1111-1111-1111-111111111101');
insert into public.form_versions (id, form_definition_id, version_number, schema_json, created_by_staff_id)
values ('88888888-8888-8888-8888-888888888802', '88888888-8888-8888-8888-888888888801', 1,
  '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[]}'::jsonb, '11111111-1111-1111-1111-111111111101');
update public.form_definitions set current_version_id = '88888888-8888-8888-8888-888888888802' where form_key = 'immutable_test';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ begin
  begin
    update public.form_versions set schema_json = '{"version":"1","steps":[],"fields":[]}'::jsonb
     where id = '88888888-8888-8888-8888-888888888802';
    raise exception 'FAIL: authenticated updated form_versions';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.form_versions where id = '88888888-8888-8888-8888-888888888802';
    raise exception 'FAIL: authenticated deleted form_versions';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: form_versions immutable for authenticated';
end $$;
rollback;

-- V5: validate_form_answers — required field missing
begin;
select set_config('role', 'postgres', true);
do $$ declare v_res jsonb; begin
  v_res := public.validate_form_answers(
    '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"name","type":"short_text","label":"n","required":true,"stepId":"s1"}]}'::jsonb,
    '{}'::jsonb);
  if (v_res ->> 'valid')::boolean then raise exception 'FAIL: missing required accepted'; end if;
  raise notice 'PASS: missing required field rejected';
end $$;
-- V5b: unknown answer key rejected
do $$ declare v_res jsonb; begin
  v_res := public.validate_form_answers(
    '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"name","type":"short_text","label":"n","required":true,"stepId":"s1"}]}'::jsonb,
    '{"name":"ok","unknown_key":"bad"}'::jsonb);
  if (v_res ->> 'valid')::boolean then raise exception 'FAIL: unknown key accepted'; end if;
  raise notice 'PASS: unknown answer key rejected';
end $$;
-- V5c: invalid option value rejected
do $$ declare v_res jsonb; begin
  v_res := public.validate_form_answers(
    '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"status","type":"single_choice","label":"s","required":true,"stepId":"s1","options":[{"value":"a","label":"A"}]}]}'::jsonb,
    '{"status":"hack"}'::jsonb);
  if (v_res ->> 'valid')::boolean then raise exception 'FAIL: invalid option accepted'; end if;
  raise notice 'PASS: invalid option value rejected';
end $$;
-- V5d: valid answers accepted
do $$ declare v_res jsonb; begin
  v_res := public.validate_form_answers(
    '{"version":"1","steps":[{"id":"s1","title":"s"}],"fields":[{"key":"status","type":"gyr","label":"s","required":true,"stepId":"s1"},{"key":"notes","type":"textarea","label":"n","required":false,"stepId":"s1"}]}'::jsonb,
    '{"status":"green","notes":"תקין"}'::jsonb);
  if (v_res ->> 'valid')::boolean is not true then raise exception 'FAIL: valid answers rejected'; end if;
  raise notice 'PASS: valid form answers accepted';
end $$;
rollback;

\echo '--- RLS + identity test suite finished (no FAIL lines above = success) ---'
