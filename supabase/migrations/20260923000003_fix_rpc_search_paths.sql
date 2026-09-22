-- ============================================================================
-- Migration 20260923000003: FIX RPC SEARCH PATHS (pgcrypto visibility)
--
-- Two deployed security-definer RPCs generate tokens with
-- gen_random_bytes() — which Supabase installs in the `extensions` schema —
-- while declaring `set search_path = public`. On any environment where
-- pgcrypto is NOT exposed via the public schema (the Supabase default) the
-- calls fail with "function gen_random_bytes(integer) does not exist":
--
--   form_campaign_create(uuid, timestamptz, timestamptz, uuid, boolean)
--   regenerate_intake_token(uuid)
--
-- Discovered by the rls_tests suite (F6) once earlier cascade failures were
-- fixed. Pure environment fix: no logic, shape, grant or audit changes.
-- ============================================================================

alter function public.form_campaign_create(uuid, timestamptz, timestamptz, uuid, boolean)
  set search_path = public, extensions;

alter function public.regenerate_intake_token(uuid)
  set search_path = public, extensions;
