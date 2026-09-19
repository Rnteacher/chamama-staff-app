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
do $$ begin
  begin
    update public.user_roles set role = 'leadership';
    raise exception 'FAIL: staff modified roles';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.user_roles;
    raise exception 'FAIL: staff deleted roles';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: staff cannot update or delete roles';
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
do $$ begin
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
  begin
    update public.students set is_archived = true;
    raise exception 'FAIL: staff archived a student';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set is_active = false;
    raise exception 'FAIL: staff deactivated a colleague';
  exception when insufficient_privilege then null; end;
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
  begin
    perform 1 from public.audit_logs limit 1;
    raise exception 'FAIL: audit logs readable by staff';
  exception when insufficient_privilege then
    raise notice 'PASS: audit logs not readable through RLS';
  end;
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

\echo '--- RLS + identity test suite finished (no FAIL lines above = success) ---'
