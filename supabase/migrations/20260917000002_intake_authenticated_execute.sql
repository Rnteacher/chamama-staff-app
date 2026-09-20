-- ============================================================================
-- Migration 20260917000002: INTAKE RPC EXECUTE FOR AUTHENTICATED
--
-- Production correction: a staff member opening a PUBLIC intake link in a
-- browser where they already have a Supabase session executes the RPC as
-- role `authenticated`, not `anon`. The earlier revoke stripped the default
-- authenticated EXECUTE and only anon was re-granted, so the same valid link
-- failed for signed-in staff with "permission denied".
--
-- Fix: grant EXECUTE on exactly the five token-gated public intake RPCs to
-- BOTH anon and authenticated. Nothing else changes:
--   * no table SELECT/INSERT grants for anon
--   * no RLS modifications
--   * no SECURITY DEFINER body changes (token + time-window validation
--     remain inside the functions)
--   * intake_window_for_token stays service_role-only (internal resolver)
--   * no PUBLIC grant, no service_role grant for these five
-- Idempotent by nature (re-granting EXECUTE is a no-op).
-- ============================================================================

grant execute on function public.public_intake_overview(text)
  to anon, authenticated;

grant execute on function public.public_intake_students(text, uuid)
  to anon, authenticated;

grant execute on function public.public_intake_majors(text)
  to anon, authenticated;

grant execute on function public.public_intake_masters(text)
  to anon, authenticated;

grant execute on function public.public_intake_submit(
  text, uuid, uuid, text, uuid, uuid
)
  to anon, authenticated;
