-- ============================================================================
-- RLS authorization tests — run against a database with migrations + seed.
--   Local dev:  supabase db reset && psql -f supabase/tests/rls_tests.sql
--   Vanilla Postgres: apply supabase/tests/local-postgres-stub.sql first.
--
-- Every test runs in its own transaction and is rolled back (except T25,
-- which commits and cleans up after itself).
-- Output: lines starting with "PASS:" / "FAIL:". A clean run has no FAILs.
--
-- IMPORTANT semantics covered here:
--   * INSERT ... RETURNING re-checks the SELECT policy — an author who cannot
--     read their own private message cannot use RETURNING (so tests insert
--     without RETURNING and verify persistence via the postgres role).
--   * UPDATE affecting zero rows (row hidden by RLS USING) does NOT raise.
-- ============================================================================

-- message ids from seed
\set msg_approved_noam     '55555555-5555-5555-5555-555555555501'
\set msg_private_noam      '55555555-5555-5555-5555-555555555502'
\set msg_hidden_noam       '55555555-5555-5555-5555-555555555503'
\set msg_private_liao      '55555555-5555-5555-5555-555555555504'
\set msg_private_maya      '55555555-5555-5555-5555-555555555505'
\set msg_approved_shachar  '55555555-5555-5555-5555-555555555507'
\set msg_hidden_shachar    '55555555-5555-5555-5555-555555555508'

\echo '--- starting RLS test suite ---'

-- ============================================================================
-- T0: schema sanity
-- ============================================================================
do $$ begin
  if (select count(*) from information_schema.tables
      where table_schema='public' and table_name in
      ('allowed_staff_emails','profiles','user_roles','greenhouse_groups','majors',
       'students','group_mentors','major_heads','master_assignments',
       'student_messages','message_reads','push_subscriptions','audit_logs')) <> 13 then
    raise exception 'FAIL: schema incomplete';
  end if;
  raise notice 'PASS: schema contains all 13 core tables';
end $$;

-- ============================================================================
-- T1: unauthorized Google user (random uuid, no profile) sees nothing;
--     deactivated allowlisted account sees nothing
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated","email":"stranger@gmail.com"}', true);
do $$ begin
  if (select count(*) from public.students) <> 0 then
    raise exception 'FAIL: unauthorized user can read students';
  end if;
  if (select count(*) from public.student_messages) <> 0 then
    raise exception 'FAIL: unauthorized user can read messages';
  end if;
  raise notice 'PASS: unauthorized account has zero access';
end $$;
rollback;

begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110b","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.students) <> 0 then
    raise exception 'FAIL: deactivated staff can read students';
  end if;
  raise notice 'PASS: deactivated allowlisted account has zero access';
end $$;
rollback;

-- ============================================================================
-- T2: general staff can send a message about ANY student
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  insert into public.student_messages (student_id, author_id, body)
  values ('44444444-4444-4444-4444-444444444404', '11111111-1111-1111-1111-11111111110a',
          'e2e-check: general staff messaging an unrelated student');
  raise notice 'PASS: general staff can message any student';
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.student_messages
      where author_id = '11111111-1111-1111-1111-11111111110a'
        and body like 'e2e-check:%') <> 1 then
    raise exception 'FAIL: message was not stored';
  end if;
  raise notice 'PASS: message persisted';
end $$;
rollback;

-- ============================================================================
-- T3: general staff cannot read an unapproved message
-- T3b: authorship alone does not grant read access
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555504') <> 0 then
    raise exception 'FAIL: general staff read an unapproved message';
  end if;
  -- tom authored msg_private_maya in the seed; must still not read it
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555505'
        and author_id = '11111111-1111-1111-1111-11111111110a') <> 0 then
    raise exception 'FAIL: author can read own private message';
  end if;
  raise notice 'PASS: general staff/author cannot read private messages';
end $$;
rollback;

-- ============================================================================
-- T4: general staff CAN read an approved-general message
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555501') <> 1 then
    raise exception 'FAIL: general staff cannot read approved message';
  end if;
  raise notice 'PASS: general staff can read approved-general messages';
end $$;
rollback;

-- ============================================================================
-- T5: assigned master can read an unapproved message for their student
-- T6: unrelated master cannot read a private message about another student
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555504') <> 1 then
    raise exception 'FAIL: assigned master cannot read private message';
  end if;
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555505') <> 0 then
    raise exception 'FAIL: unrelated master read a private message';
  end if;
  raise notice 'PASS: master reads own student only';
end $$;
rollback;

-- ============================================================================
-- T7: major head can read private messages for students in their major
-- T8: ...but not for students outside their major
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111106","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555504') <> 1 then
    raise exception 'FAIL: major head cannot read in-major private message';
  end if;
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555505') <> 0 then
    raise exception 'FAIL: major head read out-of-major private message';
  end if;
  raise notice 'PASS: major head reads in-major only';
end $$;
rollback;

-- ============================================================================
-- T9: mentor reads EVERY message about their group (incl. hidden ones)
-- ============================================================================
begin;
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
-- T10: mentor approves general visibility
-- T12: mentor blocks message from masters/major heads
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ begin
  update public.student_messages set is_general_visible = true
   where id = '55555555-5555-5555-5555-555555555502';
  if not found then
    raise exception 'FAIL: mentor could not approve visibility';
  end if;
  raise notice 'PASS: mentor of the group can approve general visibility';

  update public.student_messages set is_hidden_from_leads = true
   where id = '55555555-5555-5555-5555-555555555502';
  if not found then
    raise exception 'FAIL: mentor could not hide message from leads';
  end if;
  raise notice 'PASS: mentor of the group can block masters/major heads';
end $$;
rollback;

-- ============================================================================
-- T11: mentor from another group cannot approve (update silently hits 0 rows)
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111103","role":"authenticated"}', true);
do $$ begin
  update public.student_messages set is_general_visible = true
   where id = '55555555-5555-5555-5555-555555555502';
  if found then
    raise exception 'FAIL: mentor of another group approved visibility';
  end if;
  raise notice 'PASS: mentor of another group cannot approve';
end $$;
rollback;

-- ============================================================================
-- T13: blocked message invisible to relevant master
-- T14: ...and to relevant major head
-- T15: counselor still reads it
-- T16: project coordinator still reads it
-- T17: leadership still reads it
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
update public.student_messages set is_hidden_from_leads = true
 where id = '55555555-5555-5555-5555-555555555502';

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555502') <> 0 then
    raise exception 'FAIL: master still sees blocked message';
  end if;
  raise notice 'PASS: blocked message invisible to relevant master';
end $$;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111106","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555502') <> 0 then
    raise exception 'FAIL: major head still sees blocked message';
  end if;
  raise notice 'PASS: blocked message invisible to relevant major head';
end $$;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111107","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555502') <> 1 then
    raise exception 'FAIL: counselor cannot read blocked message';
  end if;
  raise notice 'PASS: counselor reads blocked message';
end $$;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111108","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555502') <> 1 then
    raise exception 'FAIL: coordinator cannot read blocked message';
  end if;
  raise notice 'PASS: project coordinator reads blocked message';
end $$;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555502') <> 1 then
    raise exception 'FAIL: leadership cannot read blocked message';
  end if;
  raise notice 'PASS: leadership reads blocked message';
end $$;
rollback;

-- ============================================================================
-- T18: user who is both master and mentor retains mentor access
-- (yoav inserts a private message about אריאל; איתי (mentor of רימון AND
--  master of אריאל) hides it — and can still read it via mentor precedence)
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111103","role":"authenticated"}', true);
do $$ begin
  insert into public.student_messages (student_id, author_id, body)
  values ('44444444-4444-4444-4444-44444444440b', '11111111-1111-1111-1111-111111111103',
          't18-check: message about Ariel by yoav');
  raise notice 'PASS: yoav stored the message';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111105","role":"authenticated"}', true);
do $$ begin
  update public.student_messages set is_hidden_from_leads = true
   where body like 't18-check:%';
  if not found then
    raise exception 'FAIL: master+mentor could not moderate the message';
  end if;
  if (select count(*) from public.student_messages
      where body like 't18-check:%') <> 1 then
    raise exception 'FAIL: master+mentor lost access after hiding';
  end if;
  raise notice 'PASS: master+mentor retains mentor access';
end $$;
rollback;

-- ============================================================================
-- T19: user who is major head AND leadership retains leadership access
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ begin
  -- hidden + outside her major: only leadership covers this
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555505') <> 1 then
    raise exception 'FAIL: leadership+major_head lost leadership access';
  end if;
  if (select count(*) from public.student_messages
      where id = '55555555-5555-5555-5555-555555555508') <> 1 then
    raise exception 'FAIL: leadership cannot read hidden message';
  end if;
  raise notice 'PASS: leadership+major_head retains leadership access';
end $$;
rollback;

-- ============================================================================
-- T20/T21: read state is independent per user (and strictly per-user visible)
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  insert into public.message_reads (user_id, message_id)
  values ('11111111-1111-1111-1111-11111111110a', '55555555-5555-5555-5555-555555555504');
  raise notice 'PASS: user marked own read state';
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111104","role":"authenticated"}', true);
do $$ begin
  if exists (select 1 from public.message_reads
             where user_id = '11111111-1111-1111-1111-111111111104'
               and message_id = '55555555-5555-5555-5555-555555555504') then
    raise exception 'FAIL: one user read state affected another user';
  end if;
  raise notice 'PASS: read state independent per user';
end $$;
do $$ begin
  insert into public.message_reads (user_id, message_id)
  values ('11111111-1111-1111-1111-111111111104', '55555555-5555-5555-5555-555555555504');
  -- RLS: naama may only ever see her OWN read rows
  if (select count(*) from public.message_reads
      where message_id = '55555555-5555-5555-5555-555555555504') <> 1 then
    raise exception 'FAIL: per-user read rows leaked across users';
  end if;
  raise notice 'PASS: independent marks coexist (own rows only)';
end $$;
rollback;

-- ============================================================================
-- T22: nobody can modify roles via the client
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111101","role":"authenticated"}', true);
do $$ begin
  begin
    insert into public.user_roles (user_id, role)
    values ('11111111-1111-1111-1111-111111111101', 'counselor');
    raise exception 'FAIL: super_admin self-elevated a role via client';
  exception when insufficient_privilege then
    null; -- expected
  end;
  raise notice 'PASS: users cannot modify roles (even super_admin via client)';
end $$;
rollback;

begin;
select set_config('role', 'authenticated', true);
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
-- T23: non-admin cannot alter assignments / org structure
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    insert into public.group_mentors (group_id, mentor_id)
    values ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: staff inserted mentor assignment';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.master_assignments (student_id, master_id)
    values ('44444444-4444-4444-4444-444444444404', '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: staff inserted master assignment';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.major_heads (major_id, head_id)
    values ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: staff inserted major head';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.students (first_name, last_name) values ('x', 'y');
    raise exception 'FAIL: staff created a student';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.allowed_staff_emails (email) values ('hacker@evil.com');
    raise exception 'FAIL: staff modified allowlist';
  exception when insufficient_privilege then null; end;
  begin
    update public.students set is_archived = true;
    raise exception 'FAIL: staff archived a student';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: non-admin cannot alter assignments/structure';
end $$;
rollback;

-- ============================================================================
-- T24: a non-mentor author cannot set visibility flags at insert
-- (guard trigger enforcement)
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    insert into public.student_messages (student_id, author_id, body, is_general_visible)
    values ('44444444-4444-4444-4444-444444444404', '11111111-1111-1111-1111-11111111110a', 'x', true);
    raise exception 'FAIL: non-mentor set general visibility on insert';
  exception when insufficient_privilege or check_violation then null; end;
  raise notice 'PASS: non-mentor cannot set visibility flags at insert';
end $$;
rollback;

-- ============================================================================
-- T25: mentor moderation is audited automatically (committed + cleaned up),
--      and audit_logs are not readable by staff
-- ============================================================================
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
update public.student_messages set is_general_visible = true
 where id = '55555555-5555-5555-5555-555555555502';
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

-- cleanup: restore seed state and remove test audit rows
update public.student_messages
   set is_general_visible = false,
       general_visible_by = null,
       general_visible_at = null
 where id = '55555555-5555-5555-5555-555555555502';
delete from public.audit_logs
 where entity_id = '55555555-5555-5555-5555-555555555502'
   and action like 'message_%';

\echo '--- RLS test suite finished (no FAIL lines above = success) ---'
