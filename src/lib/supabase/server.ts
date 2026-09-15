import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

// Static, direct references only: dynamic env lookups are NOT inlined by
// Next.js and would silently resolve to undefined.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function requireSupabaseConfig(): { url: string; anonKey: string } {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Set them in .env.local (development) or in the deployment environment " +
        "(Vercel → Project Settings → Environment Variables), then restart the server."
    );
  }
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
}

/**
 * Server-side client bound to the current user's cookies.
 * Every query goes through RLS as the signed-in staff member.
 */
export async function createClient(): Promise<SupabaseClient> {
  const { url, anonKey } = requireSupabaseConfig();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
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
  const { url } = requireSupabaseConfig();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Admin/notification features are disabled."
    );
  }
  if (!adminClient) {
    adminClient = createServerClient(url, serviceKey, {
      cookies: { getAll: () => [], setAll: () => undefined },
    });
  }
  return adminClient;
}
