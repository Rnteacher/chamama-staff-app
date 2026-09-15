import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Fallbacks keep `next build` happy without env vars; runtime asserts real values. */
const FALLBACK_URL = "https://placeholder.supabase.co";
const FALLBACK_ANON = "public-anon-key-placeholder";

export function supabaseUrl(): string {
  return env.NEXT_PUBLIC_SUPABASE_URL || FALLBACK_URL;
}

export function supabaseAnonKey(): string {
  return env.NEXT_PUBLIC_SUPABASE_ANON_KEY || FALLBACK_ANON;
}

/**
 * Server-side client bound to the current user's cookies.
 * Every query goes through RLS as the signed-in staff member.
 */
export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component render — safe to ignore.
          // Session refresh happens in proxy.ts.
        }
      },
    },
  });
}

let adminClient: SupabaseClient | null = null;

/**
 * Service-role client. BYPASSES RLS.
 * Server-only: the `server-only` import makes leaking into client bundles a
 * build error. Use exclusively inside verified server paths (admin actions,
 * notification routing) after checking the caller's own authorization.
 */
export function createAdminClient(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Admin/notification features are disabled."
    );
  }
  if (!adminClient) {
    adminClient = createServerClient(supabaseUrl(), key, {
      cookies: { getAll: () => [], setAll: () => undefined },
    });
  }
  return adminClient;
}
