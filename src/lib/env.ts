/**
 * Central environment access.
 * Values may be empty at build time (build must not fail without credentials);
 * runtime paths call assertSupabaseConfig() where a real connection is needed.
 */
function get(name: string): string {
  return process.env[name] ?? "";
}

export const env = {
  NEXT_PUBLIC_SUPABASE_URL: get("NEXT_PUBLIC_SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: get("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
  NEXT_PUBLIC_ENABLE_EMAIL_LOGIN:
    get("NEXT_PUBLIC_ENABLE_EMAIL_LOGIN") === "true",
  SUPABASE_SERVICE_ROLE_KEY: get("SUPABASE_SERVICE_ROLE_KEY"),
  VAPID_PRIVATE_KEY: get("VAPID_PRIVATE_KEY"),
  VAPID_SUBJECT: get("VAPID_SUBJECT"),
};

export function hasSupabaseConfig(): boolean {
  return Boolean(
    env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function hasVapidConfig(): boolean {
  return Boolean(
    env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
      env.VAPID_PRIVATE_KEY &&
      env.VAPID_SUBJECT
  );
}

export function hasAdminConfig(): boolean {
  return Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
}
