import { createBrowserClient as createSBBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";

/** Fallbacks keep `next build` happy without env vars. */
const FALLBACK_URL = "https://placeholder.supabase.co";
const FALLBACK_ANON = "public-anon-key-placeholder";

/** Browser client bound to the user's cookies (RLS applies to every query). */
export function createBrowserClient() {
  return createSBBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL || FALLBACK_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY || FALLBACK_ANON
  );
}
