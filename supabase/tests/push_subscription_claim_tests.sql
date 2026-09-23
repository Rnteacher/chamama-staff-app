-- ============================================================================
-- Push subscription ownership tests (migration 20260923000005).
--   supabase db reset && psql -f supabase/tests/push_subscription_claim_tests.sql
--
-- claim_push_subscription() saves the caller's own browser subscription and
-- transfers it atomically when the same browser subscription is still
-- registered to another staff member. RLS on push_subscriptions itself is
-- unchanged (per-owner only).
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

\set itay     '11111111-1111-1111-1111-111111111105'
\set michal   '11111111-1111-1111-1111-111111111102'
-- dana: linked, inactive
\set dana     '11111111-1111-1111-1111-11111111110b'

\echo '--- starting push subscription claim test suite ---'

-- helper: act as the signed-in account of a staff member
create or replace function pg_temp.act_as(p_staff uuid)
returns void language plpgsql as $$
declare v_uid uuid;
begin
  select auth_user_id into v_uid from public.profiles where id = p_staff;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.act_as_postgres()
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ============================================================================
-- PC1: A owns X -> B claims X -> exactly one X row, owned by B, audited;
--      A no longer receives through X
-- ============================================================================
begin;
select pg_temp.act_as(:'itay');
do $$
begin
  if public.claim_push_subscription('https://push.example/X', 'P256-X', 'AUTH-X', 'ua-a') <> 'ok' then
    raise exception 'FAIL: first claim by A did not return ok';
  end if;
end $$;
select pg_temp.act_as(:'michal');
do $$
declare v text;
begin
  v := public.claim_push_subscription('https://push.example/X', 'P256-X', 'AUTH-X', 'ua-b');
  if v <> 'transferred' then
    raise exception 'FAIL: claim by B returned % (expected transferred)', v;
  end if;
end $$;
select pg_temp.act_as_postgres();
do $$
declare v_rows int; v_owner uuid; v_a_rows int; v_audit int;
begin
  select count(*), max(staff_id::text)::uuid into v_rows, v_owner
    from public.push_subscriptions where endpoint = 'https://push.example/X';
  if v_rows <> 1 then
    raise exception 'FAIL: expected exactly one row for X, found %', v_rows;
  end if;
  if v_owner <> '11111111-1111-1111-1111-111111111102' then
    raise exception 'FAIL: X owner is % (expected B)', v_owner;
  end if;
  -- the delivery query (sendPushToUsers) selects subscriptions by staff_id:
  -- A must have no route through X any more
  select count(*) into v_a_rows from public.push_subscriptions
   where staff_id = '11111111-1111-1111-1111-111111111105'
     and endpoint = 'https://push.example/X';
  if v_a_rows <> 0 then
    raise exception 'FAIL: A still receives through X';
  end if;
  select count(*) into v_audit from public.audit_logs
   where action = 'push_subscription_transferred'
     and actor_staff_id = '11111111-1111-1111-1111-111111111102'
     and metadata ->> 'from_staff_id' = '11111111-1111-1111-1111-111111111105';
  if v_audit <> 1 then
    raise exception 'FAIL: transfer not audited exactly once (% rows)', v_audit;
  end if;
  raise notice 'PASS: B claims A''s subscription X — one row, owned by B, A no longer receives through X, audited';
end $$;
rollback;

-- ============================================================================
-- PC2: same-owner repeat claim is idempotent (same row, no audit noise);
--      the owner may refresh keys of their own row
-- ============================================================================
begin;
select pg_temp.act_as(:'itay');
do $$
declare v_id1 uuid; v_id2 uuid; v_created1 timestamptz; v_created2 timestamptz; v_rows int; v_audit int;
begin
  perform public.claim_push_subscription('https://push.example/Y', 'P256-Y', 'AUTH-Y', 'ua');
  select id, created_at into v_id1, v_created1 from public.push_subscriptions where endpoint = 'https://push.example/Y';
  if public.claim_push_subscription('https://push.example/Y', 'P256-Y', 'AUTH-Y', 'ua') <> 'ok'
     or public.claim_push_subscription('https://push.example/Y', 'P256-Y2', 'AUTH-Y2', 'ua') <> 'ok' then
    raise exception 'FAIL: repeat claim by the owner did not return ok';
  end if;
  select id, created_at into v_id2, v_created2 from public.push_subscriptions where endpoint = 'https://push.example/Y';
  select count(*) into v_rows from public.push_subscriptions where endpoint = 'https://push.example/Y';
  if v_rows <> 1 or v_id1 <> v_id2 or v_created1 <> v_created2 then
    raise exception 'FAIL: repeat claim changed identity (rows=%, same id=%)', v_rows, v_id1 = v_id2;
  end if;
  if not exists (select 1 from public.push_subscriptions
                  where endpoint = 'https://push.example/Y' and p256dh = 'P256-Y2' and auth = 'AUTH-Y2') then
    raise exception 'FAIL: owner key refresh not stored';
  end if;
  perform pg_temp.act_as_postgres();
  select count(*) into v_audit from public.audit_logs
   where action like 'push_subscription_%' and metadata ->> 'to_staff_id' = '11111111-1111-1111-1111-111111111105';
  if v_audit <> 0 then
    raise exception 'FAIL: same-owner claim produced % audit rows', v_audit;
  end if;
  raise notice 'PASS: same-owner repeat claim is idempotent (one row, same id, no audit rows)';
end $$;
rollback;

-- ============================================================================
-- PC3: another staff member cannot take over a subscription with only its
--      endpoint (keys differ) — nothing changes, the attempt is audited
-- ============================================================================
begin;
select pg_temp.act_as(:'itay');
select public.claim_push_subscription('https://push.example/Z', 'P256-Z', 'AUTH-Z', null);
select pg_temp.act_as(:'michal');
do $$
declare v text;
begin
  v := public.claim_push_subscription('https://push.example/Z', 'P256-OTHER', 'AUTH-OTHER', null);
  if v <> 'mismatch' then
    raise exception 'FAIL: endpoint-only takeover returned %', v;
  end if;
  v := public.claim_push_subscription('https://push.example/Z', 'P256-Z', 'AUTH-WRONG', null);
  if v <> 'mismatch' then
    raise exception 'FAIL: takeover with wrong auth secret returned %', v;
  end if;
end $$;
select pg_temp.act_as_postgres();
do $$
begin
  if not exists (select 1 from public.push_subscriptions
                  where endpoint = 'https://push.example/Z'
                    and staff_id = '11111111-1111-1111-1111-111111111105'
                    and p256dh = 'P256-Z' and auth = 'AUTH-Z') then
    raise exception 'FAIL: mismatched claim modified the row';
  end if;
  if (select count(*) from public.audit_logs where action = 'push_subscription_claim_denied'
        and actor_staff_id = '11111111-1111-1111-1111-111111111102') <> 2 then
    raise exception 'FAIL: denied takeover attempts not audited';
  end if;
  raise notice 'PASS: takeover without the browser''s keys is refused, row unchanged, attempt audited';
end $$;
rollback;

-- ============================================================================
-- PC4: anonymous callers are blocked (no grant; no auth.uid())
-- ============================================================================
begin;
do $$
begin
  if has_function_privilege('anon', 'public.claim_push_subscription(text,text,text,text)', 'execute') then
    raise exception 'FAIL: anon may execute claim_push_subscription';
  end if;
  if not has_function_privilege('authenticated', 'public.claim_push_subscription(text,text,text,text)', 'execute') then
    raise exception 'FAIL: authenticated may not execute claim_push_subscription';
  end if;
end $$;
select set_config('request.jwt.claims', '', true);
select set_config('role', 'anon', true);
do $$
begin
  begin
    perform public.claim_push_subscription('https://push.example/ANON', 'P', 'A', null);
    raise exception 'FAIL: anonymous claim succeeded';
  exception when insufficient_privilege then
    null;
  end;
end $$;
select pg_temp.act_as_postgres();
do $$
begin
  -- even a role that can execute gets nothing without an authenticated uid
  begin
    perform public.claim_push_subscription('https://push.example/ANON', 'P', 'A', null);
    raise exception 'FAIL: claim without auth.uid() succeeded';
  exception when insufficient_privilege then
    null;
  end;
  if exists (select 1 from public.push_subscriptions where endpoint = 'https://push.example/ANON') then
    raise exception 'FAIL: anonymous claim stored a row';
  end if;
  raise notice 'PASS: anonymous claim blocked (no execute grant; no auth.uid() -> refused)';
end $$;
rollback;

-- ============================================================================
-- PC5: unlinked and inactive staff are blocked
-- ============================================================================
begin;
-- a valid auth account that is not linked to any staff profile
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000dead', 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
do $$
begin
  begin
    perform public.claim_push_subscription('https://push.example/U', 'P', 'A', null);
    raise exception 'FAIL: unlinked account claim succeeded';
  exception when insufficient_privilege then
    null;
  end;
end $$;
-- linked but inactive
select pg_temp.act_as(:'dana');
do $$
begin
  begin
    perform public.claim_push_subscription('https://push.example/U', 'P', 'A', null);
    raise exception 'FAIL: inactive staff claim succeeded';
  exception when insufficient_privilege then
    null;
  end;
end $$;
select pg_temp.act_as_postgres();
do $$
begin
  if exists (select 1 from public.push_subscriptions where endpoint = 'https://push.example/U') then
    raise exception 'FAIL: blocked claim stored a row';
  end if;
  raise notice 'PASS: unlinked and inactive accounts cannot claim';
end $$;
rollback;

-- ============================================================================
-- PC6: an inactive owner's subscription can be taken over by the active
--      staff member now signed in on that browser (same keys)
-- ============================================================================
begin;
insert into public.push_subscriptions (staff_id, endpoint, p256dh, auth)
values (:'dana', 'https://push.example/D', 'P256-D', 'AUTH-D');
select pg_temp.act_as(:'michal');
do $$
begin
  if public.claim_push_subscription('https://push.example/D', 'P256-D', 'AUTH-D', null) <> 'transferred' then
    raise exception 'FAIL: takeover from inactive owner not transferred';
  end if;
end $$;
select pg_temp.act_as_postgres();
do $$
begin
  if (select staff_id from public.push_subscriptions where endpoint = 'https://push.example/D')
     <> '11111111-1111-1111-1111-111111111102' then
    raise exception 'FAIL: owner not updated';
  end if;
  raise notice 'PASS: subscription of an inactive former owner transfers to the signed-in staff member';
end $$;
rollback;

-- ============================================================================
-- PC7: ordinary authenticated staff still cannot touch unrelated
--      push_subscriptions rows directly (per-owner RLS unchanged)
-- ============================================================================
begin;
insert into public.push_subscriptions (staff_id, endpoint, p256dh, auth)
values (:'itay', 'https://push.example/R', 'P256-R', 'AUTH-R');
select pg_temp.act_as(:'michal');
do $$
declare v_n int;
begin
  select count(*) into v_n from public.push_subscriptions where endpoint = 'https://push.example/R';
  if v_n <> 0 then
    raise exception 'FAIL: other staff can read another member''s subscription';
  end if;
  update public.push_subscriptions
     set staff_id = '11111111-1111-1111-1111-111111111102', auth = 'HIJACK'
   where endpoint = 'https://push.example/R';
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'FAIL: direct UPDATE of another member''s subscription affected % rows', v_n;
  end if;
  delete from public.push_subscriptions where endpoint = 'https://push.example/R';
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'FAIL: direct DELETE of another member''s subscription affected % rows', v_n;
  end if;
  begin
    insert into public.push_subscriptions (staff_id, endpoint, p256dh, auth)
    values ('11111111-1111-1111-1111-111111111102', 'https://push.example/R', 'x', 'y')
    on conflict (endpoint) do update set staff_id = excluded.staff_id, auth = excluded.auth;
    raise exception 'FAIL: direct upsert took over another member''s subscription';
  exception when insufficient_privilege then
    null; -- RLS: new row violates / update not permitted
  end;
  begin
    insert into public.push_subscriptions (staff_id, endpoint, p256dh, auth)
    values ('11111111-1111-1111-1111-111111111105', 'https://push.example/NEW', 'x', 'y');
    raise exception 'FAIL: inserted a subscription owned by someone else';
  exception when insufficient_privilege then
    null;
  end;
end $$;
select pg_temp.act_as_postgres();
do $$
begin
  if not exists (select 1 from public.push_subscriptions
                  where endpoint = 'https://push.example/R'
                    and staff_id = '11111111-1111-1111-1111-111111111105' and auth = 'AUTH-R') then
    raise exception 'FAIL: unrelated row was modified';
  end if;
  raise notice 'PASS: authenticated staff cannot read/update/delete/upsert unrelated subscription rows directly';
end $$;
rollback;

-- ============================================================================
-- PC8: the claim touches only the supplied endpoint; input is validated;
--      the function is SECURITY DEFINER with a pinned search_path
-- ============================================================================
begin;
insert into public.push_subscriptions (staff_id, endpoint, p256dh, auth)
values (:'itay', 'https://push.example/OTHER', 'P256-O', 'AUTH-O');
select pg_temp.act_as(:'michal');
select public.claim_push_subscription('https://push.example/MINE', 'P256-M', 'AUTH-M', null);
do $$
begin
  begin
    perform public.claim_push_subscription('http://insecure.example/x', 'P', 'A', null);
    raise exception 'FAIL: non-https endpoint accepted';
  exception when invalid_parameter_value then
    null;
  end;
  begin
    perform public.claim_push_subscription('https://push.example/E', '', 'A', null);
    raise exception 'FAIL: empty key accepted';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
select pg_temp.act_as_postgres();
do $$
declare v_cfg text[];
begin
  if not exists (select 1 from public.push_subscriptions
                  where endpoint = 'https://push.example/OTHER'
                    and staff_id = '11111111-1111-1111-1111-111111111105' and auth = 'AUTH-O') then
    raise exception 'FAIL: claim of one endpoint modified another row';
  end if;
  select proconfig into v_cfg from pg_proc
   where oid = 'public.claim_push_subscription(text,text,text,text)'::regprocedure;
  if not (select prosecdef from pg_proc
           where oid = 'public.claim_push_subscription(text,text,text,text)'::regprocedure)
     or not ('search_path=public' = any (v_cfg)) then
    raise exception 'FAIL: claim_push_subscription must be SECURITY DEFINER with search_path=public (%)', v_cfg;
  end if;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = 'public.claim_push_subscription(text,text,text,text)'::regprocedure
                and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'FAIL: PUBLIC may execute claim_push_subscription';
  end if;
  raise notice 'PASS: claim affects only the supplied endpoint; invalid input rejected; definer + pinned search_path; no PUBLIC execute';
end $$;
rollback;

\echo '--- push subscription claim test suite finished ---'
