/**
 * Public (browser-exposed) environment variables.
 *
 * NEXT_PUBLIC_* values are inlined into the client bundle by Next.js ONLY
 * when accessed statically (process.env.NEXT_PUBLIC_X). Never read these
 * names dynamically and never fall back to fake URLs — a missing variable
 * must surface as a clear error instead of silently pointing OAuth at a
 * wrong host.
 *
 * Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, VAPID_PRIVATE_KEY,
 * VAPID_SUBJECT) are intentionally NOT read here — they live in
 * `src/lib/server-env.ts` and in the server-only Supabase modules.
 */
export const PUBLIC_SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const PUBLIC_SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const PUBLIC_VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
export const ENABLE_EMAIL_LOGIN =
  process.env.NEXT_PUBLIC_ENABLE_EMAIL_LOGIN === "true";

export function hasSupabaseConfig(): boolean {
  return Boolean(PUBLIC_SUPABASE_URL && PUBLIC_SUPABASE_ANON_KEY);
}
