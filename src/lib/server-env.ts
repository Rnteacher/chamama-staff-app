import "server-only";

/**
 * Server-only environment diagnostics. Read directly and statically; these
 * values must never reach the client bundle (`server-only` enforces it).
 */
export function hasAdminConfig(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function hasVapidConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT
  );
}
