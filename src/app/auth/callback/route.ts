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
  if (error) {
    // Exchange failed (e.g. stale PKCE verifier) — back to login, NOT
    // the access-denied page.
    return NextResponse.redirect(`${origin}/login?error=exchange`);
  }

  // Link the authenticated Google account to its staff identity.
  // Atomic, server/database-side; never trusts browser-provided emails.
  // Results: 'ok' | 'unauthorized' | 'inactive' | 'conflict' | 'email_unverified'
  const { data: claimStatus, error: claimError } = await supabase.rpc(
    "claim_staff_identity"
  );
  if (claimError || (claimStatus && claimStatus !== "ok")) {
    const reason =
      (typeof claimStatus === "string" && claimStatus) || "error";
    return NextResponse.redirect(
      `${origin}/access-denied?reason=${encodeURIComponent(reason)}`
    );
  }

  const target =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(`${origin}${target}`);
}
