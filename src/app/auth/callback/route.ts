import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const next = searchParams.get("next");
  const code = searchParams.get("code");

  // OAuth provider errors (user denied, Google blocked the request, etc.)
  // surface here — treat them as LOGIN failures, not authorization failures.
  const oauthError =
    searchParams.get("error") ?? searchParams.get("error_code") ?? null;
  const oauthDescription = searchParams.get("error_description");

  if (!code || oauthError) {
    const params = new URLSearchParams({ error: "oauth" });
    if (oauthError) {
      params.set(
        "reason",
        `${oauthError}${oauthDescription ? `: ${oauthDescription}` : ""}`.slice(
          0,
          300
        )
      );
    }
    return NextResponse.redirect(`${origin}/login?${params.toString()}`);
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (!error) {
    const target =
      next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    return NextResponse.redirect(`${origin}${target}`);
  }

  // Exchange failed (e.g. stale PKCE verifier after switching ports) —
  // back to login with a clear message, NOT the access-denied page.
  return NextResponse.redirect(`${origin}/login?error=exchange`);
}
