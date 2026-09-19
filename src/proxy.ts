import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Network-boundary guard (Next.js 16 "proxy", Node runtime).
 *
 * - refreshes the Supabase session cookie on every request
 * - redirects signed-out users to /login
 * - verifies the signed-in account is an active, allowlisted staff member
 *   (unauthorized accounts land on /access-denied and never reach data pages)
 *
 * This is defense-in-depth only: every page/action re-checks authorization
 * and RLS enforces permissions inside the database.
 */

const PUBLIC_PATHS = new Set(["/login", "/access-denied", "/auth/callback"]);

// Static, direct references — required for correct env resolution.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function proxy(request: NextRequest) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error(
      "proxy: missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — " +
        "set them in .env.local (development) or the deployment environment."
    );
    return new Response(
      "Server configuration error: Supabase environment variables are missing.",
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user) {
    if (PUBLIC_PATHS.has(pathname)) return response;
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Signed in: only claimed, active staff identities may proceed.
  // (The claim — linking auth_user_id to the staff record — happens in the
  // auth callback via the claim_staff_identity() RPC.)
  const { data: staff } = await supabase
    .from("profiles")
    .select("id, is_active")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!staff?.is_active) {
    if (pathname === "/access-denied") return response;
    return NextResponse.redirect(new URL("/access-denied", request.url));
  }

  if (PUBLIC_PATHS.has(pathname)) {
    // Authorized staff has no business on login/access-denied pages
    if (pathname !== "/auth/callback") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    // everything except static assets, image optimization, SW and manifest
    "/((?!_next/static|_next/image|_next/data|icons/|logo.png|icon.png|apple-icon.png|sw.js|manifest.webmanifest|favicon.ico).*)",
  ],
};
