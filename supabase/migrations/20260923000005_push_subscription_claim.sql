-- ============================================================================
-- Push subscription ownership transfer (additive).
--
-- A browser push subscription endpoint belongs to ONE staff identity at a
-- time (push_subscriptions.endpoint is unique). Until now the app saved it
-- with a client-side upsert under the per-owner RLS policies, so when staff B
-- signed in on a browser whose subscription was still registered to staff A
-- the UPDATE branch was rejected by RLS: the row stayed A's, A's
-- notifications kept reaching B's browser, and B's save failed on every load.
--
-- claim_push_subscription() is the single, narrow path that saves the
-- caller's OWN browser subscription and, when needed, moves it to the caller:
--   * only an authenticated, linked, ACTIVE staff member may call it
--     (current_staff_id(); anon has no execute grant);
--   * it touches exactly the one row whose endpoint the caller supplied;
--   * taking over a row owned by someone else requires the complete
--     subscription (endpoint + p256dh + auth secret), i.e. the values only
--     the subscribed browser holds — knowing an endpoint alone is not enough;
--   * the transfer is one atomic upsert (no duplicate rows, no window in
--     which both staff own it), recorded in audit_logs.
-- The existing per-owner RLS policies on push_subscriptions are unchanged;
-- authenticated users gain no UPDATE access to rows they do not own.
--
-- Returns: 'ok' (saved for the caller) | 'transferred' (taken over from
-- another staff member) | 'mismatch' (endpoint owned by someone else and the
-- presented keys differ — nothing changed).
-- ============================================================================

create or replace function public.claim_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff      uuid := public.current_staff_id();
  v_prev_owner uuid;
  v_id         uuid;
begin
  if auth.uid() is null or v_staff is null then
    raise exception 'not an authorized staff member' using errcode = '42501';
  end if;

  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 2048
     or coalesce(p_p256dh, '') = '' or length(p_p256dh) > 512
     or coalesce(p_auth, '') = '' or length(p_auth) > 512 then
    raise exception 'invalid push subscription' using errcode = '22023';
  end if;

  -- lock the existing row (if any) so concurrent claims serialize
  select staff_id into v_prev_owner
    from public.push_subscriptions
   where endpoint = p_endpoint
   for update;

  insert into public.push_subscriptions as s
         (staff_id, endpoint, p256dh, auth, user_agent, updated_at)
  values (v_staff, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300), now())
  on conflict (endpoint) do update
     set staff_id   = excluded.staff_id,
         p256dh     = excluded.p256dh,
         auth       = excluded.auth,
         user_agent = excluded.user_agent,
         updated_at = now()
   -- same owner: refresh freely; another owner: only with the same keys
   where s.staff_id = excluded.staff_id
      or (s.p256dh = excluded.p256dh and s.auth = excluded.auth)
  returning s.id into v_id;

  if v_id is null then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    select v_staff, 'push_subscription_claim_denied', 'push_subscription', s.id,
           jsonb_build_object('reason', 'key_mismatch', 'owner_staff_id', s.staff_id)
      from public.push_subscriptions s
     where s.endpoint = p_endpoint;
    return 'mismatch';
  end if;

  if v_prev_owner is not null and v_prev_owner <> v_staff then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_staff, 'push_subscription_transferred', 'push_subscription', v_id,
            jsonb_build_object('from_staff_id', v_prev_owner, 'to_staff_id', v_staff));
    return 'transferred';
  end if;

  return 'ok';
end;
$$;

revoke all on function public.claim_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.claim_push_subscription(text, text, text, text) to authenticated;
