import { createBrowserClient as createSBBrowserClient } from "@supabase/ssr";

/**
 * Browser client bound to the user's cookies (RLS applies to every query).
 * Direct static references are REQUIRED here: Next.js only inlines
 * NEXT_PUBLIC_* variables that are accessed statically, and this module runs
 * in the browser where no runtime process.env exists.
 */
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Set them in .env.local and restart the dev server."
    );
  }

  return createSBBrowserClient(url, anonKey);
}
