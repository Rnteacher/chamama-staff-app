-- ============================================================================
-- Intake public-token lookup behavioral tests (migration 20260921000003)
--   run: psql "$SUPABASE_DB_URL" -f supabase/tests/intake_token_tests.sql
-- Proves:
--   1. the LEGACY window token keeps resolving (never invalidated)
--   2. an ADDITIONAL child token resolves to the SAME window
--   3. unknown tokens stay invalid
--   4. disable (is_revoked) stops BOTH tokens; reactivate restores BOTH
--      with the SAME links — no token rotation needed
--   5. soft-deleted windows stop resolving entirely
-- Runs in one transaction and rolls back.
-- ============================================================================

\set ronen '11111111-1111-1111-1111-111111111101'
\set window_id 'f0000000-0000-0000-0000-000000000001'

begin;

select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where id = :'ronen';

insert into public.intake_windows (id, title, token_hash, opens_at, closes_at, is_revoked, created_by_staff_id)
values (
  :'window_id',
  'בדיקת קישורים',
  encode(sha256(convert_to('legacy-token-abc', 'UTF8')), 'hex'),
  now() - interval '1 hour',
  now() + interval '7 days',
  false,
  :'ronen'
) on conflict (id) do update
  set token_hash = excluded.token_hash,
      opens_at = excluded.opens_at,
      closes_at = excluded.closes_at,
      is_revoked = false,
      deleted_at = null;

-- additional recoverable token pointing at the SAME window
insert into public.intake_window_tokens (intake_window_id, token_hash)
values (:'window_id', encode(sha256(convert_to('additional-token-xyz', 'UTF8')), 'hex'))
on conflict (token_hash) do nothing;

-- --------------------------------------------------------------- legacy ---
select set_config('role', 'anon', true);
do $$
declare r jsonb;
begin
  r := public.public_intake_overview('legacy-token-abc');
  if r ->> 'status' = 'open' then
    raise notice 'PASS: legacy window link resolves (still valid)';
  else
    raise exception 'FAIL: legacy link broken, got %', r ->> 'status';
  end if;
end $$;

-- ------------------------------------------------------------ additional ---
do $$
declare r jsonb;
begin
  r := public.public_intake_overview('additional-token-xyz');
  if r ->> 'status' = 'open' then
    raise notice 'PASS: additional child token resolves to the same window';
  else
    raise exception 'FAIL: additional token broken, got %', r ->> 'status';
  end if;
end $$;

-- -------------------------------------------------------------- unknown ---
do $$
declare r jsonb;
begin
  r := public.public_intake_overview('unknown-token-123');
  if r ->> 'status' = 'invalid' then
    raise notice 'PASS: unknown token invalid';
  else
    raise exception 'FAIL: unknown token accepted';
  end if;
end $$;

-- ------------------------------------------------ disable → reactivate ---
select set_config('role', 'postgres', true);
update public.intake_windows set is_revoked = true where id = :'window_id';
select set_config('role', 'anon', true);
do $$
declare a jsonb; b jsonb;
begin
  a := public.public_intake_overview('legacy-token-abc');
  b := public.public_intake_overview('additional-token-xyz');
  if a ->> 'status' = 'invalid' and b ->> 'status' = 'invalid' then
    raise notice 'PASS: disable stops new submissions for BOTH tokens';
  else
    raise exception 'FAIL: disable left a token active (% / %)', a ->> 'status', b ->> 'status';
  end if;
end $$;

select set_config('role', 'postgres', true);
update public.intake_windows set is_revoked = false where id = :'window_id';
select set_config('role', 'anon', true);
do $$
declare a jsonb; b jsonb;
begin
  a := public.public_intake_overview('legacy-token-abc');
  b := public.public_intake_overview('additional-token-xyz');
  if a ->> 'status' = 'open' and b ->> 'status' = 'open' then
    raise notice 'PASS: reactivate restores BOTH links without token rotation';
  else
    raise exception 'FAIL: reactivate did not restore links (% / %)', a ->> 'status', b ->> 'status';
  end if;
end $$;

-- ---------------------------------------------------------- soft delete ---
select set_config('role', 'postgres', true);
update public.intake_windows set deleted_at = now() where id = :'window_id';
select set_config('role', 'anon', true);
do $$
declare a jsonb; b jsonb;
begin
  a := public.public_intake_overview('legacy-token-abc');
  b := public.public_intake_overview('additional-token-xyz');
  if a ->> 'status' = 'invalid' and b ->> 'status' = 'invalid' then
    raise notice 'PASS: soft-deleted window stops resolving entirely';
  else
    raise exception 'FAIL: soft-deleted window still resolves (% / %)', a ->> 'status', b ->> 'status';
  end if;
end $$;

rollback;
