-- ============================================================================
-- INTAKE LINK DIAGNOSTICS — run in the Supabase SQL Editor (READ-ONLY)
--
-- Purpose: when a freshly-generated intake link shows "הקישור אינו תקין",
-- these queries identify whether the problem is the stored hash, the deployed
-- RPC body, or the window state — WITHOUT exposing any raw token.
--
-- Nothing here modifies data.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The latest intake window (id, times, state — and the hash's LENGTH and
--    a short prefix only; never the full hash, never any raw token)
-- ---------------------------------------------------------------------------
select
  id,
  title,
  opens_at,
  closes_at,
  is_revoked,
  created_at,
  length(token_hash)                                   as token_hash_len,   -- expect 64
  left(token_hash, 8) || '…'                           as token_hash_prefix,
  token_hash ~ '^[0-9a-f]{64}$'                        as token_hash_is_lower_hex
from public.intake_windows
order by created_at desc
limit 5;

-- ---------------------------------------------------------------------------
-- 2. Which RPC body is actually deployed?
--    Expect: position of 'sha256(' > 0 and position of 'digest(' = 0.
--    If 'digest(' is present, the old pgcrypto-dependent body is deployed —
--    apply migration 20260917000001 (or re-run the fixed 20260916000001).
-- ---------------------------------------------------------------------------
select
  proname,
  position('sha256(' in prosrc)  > 0 as uses_sha256,
  position('digest('  in prosrc) > 0 as uses_old_digest
from pg_proc
where proname in ('intake_window_for_token', 'public_intake_overview')
order by proname;

-- ---------------------------------------------------------------------------
-- 3. Test a raw token from a SAVED link WITHOUT inserting anything:
--    paste the raw token from your saved link between the quotes below.
--    Compare the computed hash with the stored token_hash from query 1.
--    (Node equivalent: crypto.createHash('sha256').update(token,'utf8').digest('hex'))
-- ---------------------------------------------------------------------------
select
  encode(sha256(convert_to('PASTE-RAW-TOKEN-HERE', 'UTF8')), 'hex') as computed_hash,
  (select token_hash from public.intake_windows order by created_at desc limit 1) as stored_hash,
  encode(sha256(convert_to('PASTE-RAW-TOKEN-HERE', 'UTF8')), 'hex')
    = (select token_hash from public.intake_windows order by created_at desc limit 1) as hashes_match;

-- ---------------------------------------------------------------------------
-- 4. Live RPC check (returns a status jsonb — never an error, never a token)
-- ---------------------------------------------------------------------------
select public.public_intake_overview('PASTE-RAW-TOKEN-HERE') as overview_status;

-- ---------------------------------------------------------------------------
-- 5. Does anon have EXECUTE on the public RPCs? (expect t on all rows)
-- ---------------------------------------------------------------------------
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'public_intake_overview', 'public_intake_students',
    'public_intake_majors', 'public_intake_masters', 'public_intake_submit'
  )
order by p.proname;
