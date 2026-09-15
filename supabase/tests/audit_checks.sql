-- ============================================================================
-- Security audit extras: notification-routing RPCs must never leak content
-- to users who cannot read the underlying message.
-- ============================================================================

\echo '--- audit: notification RPC leakage checks ---'

-- A) get_message_recipients is service-role only
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform * from public.get_message_recipients('55555555-5555-5555-5555-555555555502');
    raise exception 'FAIL: authenticated user can call get_message_recipients';
  exception when insufficient_privilege then
    raise notice 'PASS: get_message_recipients is service-role only';
  end;
end $$;
rollback;

-- B) unread_messages (definer RPC) returns ONLY messages the caller may read
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ declare c int; begin
  select count(*) into c from public.unread_messages(100, 0);
  -- tom (general staff) may read ONLY approved messages: msg01 (read in seed),
  -- msg07, msg09, msg0c (approved, unread) → exactly 3 unread rows
  if c <> 3 then
    raise exception 'FAIL: unread_messages wrong rows for general staff (got %)', c;
  end if;
  if exists (select 1 from public.unread_messages(100, 0)
             where message_id in ('55555555-5555-5555-5555-555555555502',
                                  '55555555-5555-5555-5555-555555555505')) then
    raise exception 'FAIL: unread_messages leaked private message content';
  end if;
  raise notice 'PASS: unread_messages respects read permissions';
end $$;
rollback;

-- C) recipient list for a HIDDEN message excludes masters/major heads
begin;
select set_config('role', 'postgres', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
-- michal (mentor) hides a message via authenticated context is not needed;
-- flip the flag as the seeded state already has msg03 hidden.
do $$ declare n int; begin
  select count(*) into n from public.get_message_recipients('55555555-5555-5555-5555-555555555503');
  -- hidden from leads: expected recipients = mentor michal(…102, author? no—author of msg03 IS michal, excluded)
  -- + naama? master of נועם → EXCLUDED (hidden). roni (major head תקשורת) → EXCLUDED.
  -- privileged: shira(107), amit(108), liat(109) → included. yoav? mentor of שקד only → no.
  -- expected: 107,108,109 = 3
  if n <> 3 then
    raise exception 'FAIL: hidden message recipients = % (expected 3)', n;
  end if;
  raise notice 'PASS: hidden message notified to privileged roles only (3)';
end $$;
rollback;

-- D) recipient list for a private-but-visible message includes master+head
begin;
select set_config('role', 'postgres', true);
do $$ declare n int; begin
  select count(*) into n from public.get_message_recipients('55555555-5555-5555-5555-555555555504');
  -- msg04 about ליאו by roni (author excluded): master naama(104), mentor yoav(103),
  -- major head roni(106 — author, excluded), privileged 107/108/109 → expected 5
  if n <> 5 then
    raise exception 'FAIL: recipients = % (expected 5)', n;
  end if;
  raise notice 'PASS: private message routed to mentor+master+privileged (5)';
end $$;
rollback;

\echo '--- audit checks finished ---'
