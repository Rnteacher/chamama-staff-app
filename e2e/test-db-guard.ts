import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Fail-closed guard for E2E/test code that mutates Supabase data.
 *
 * EVERY test-side direct DB mutation must go through getE2eAdminClient().
 * The guard refuses to hand out a client unless ALL of the following hold:
 *
 *   1. ALLOW_E2E_DB_MUTATION=true is explicitly set (not merely NODE_ENV).
 *   2. The target URL is well-formed and points at an APPROVED target:
 *      a local database (localhost/127.0.0.1/::1/*.local) or the dedicated
 *      E2E test project (hosted project whose ref matches
 *      E2E_TEST_PROJECT_REF).
 *   3. The target does NOT match the application's configured (production)
 *      Supabase host/ref — checked first, so it blocks even when the opt-in
 *      variable is present. Production refs are collected from the process
 *      environment and from .env.local (NEXT_PUBLIC_SUPABASE_URL).
 *
 * The default target is the local stack (http://127.0.0.1:54331). Test code
 * must never read the application's .env.local Supabase URL/key for seeding.
 */

export interface GuardInput {
  /** URL the test client will mutate. */
  targetUrl: string | undefined;
  /** Raw value of ALLOW_E2E_DB_MUTATION. */
  allowMutation: string | undefined;
  /** Raw value of E2E_TEST_PROJECT_REF (dedicated test project ref). */
  testProjectRef: string | undefined;
  /** URLs/refs of projects that must never be mutated (production). */
  appProdUrls: string[];
  /** Hosts treated as local test databases. */
  localHosts?: string[];
}

export interface GuardResult {
  allowed: boolean;
  reason: string;
}

/** Extracts the hosted-project ref (<ref>.supabase.<tld>), else null. */
export function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)supabase\.(co|net|red|in)$/.test(host)) {
    return host.split(".")[0] ?? null;
  }
  return null;
}

/**
 * Pure classification of a test mutation target. Order matters:
 * production match → blocked (even with opt-in), then opt-in, then allowlist.
 */
export function classifyTestDbTarget(input: GuardInput): GuardResult {
  // -- 1. URL sanity (fail closed on missing/malformed) ---------------------
  if (!input.targetUrl || input.targetUrl.trim() === "") {
    return { allowed: false, reason: "missing E2E Supabase URL" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.targetUrl);
  } catch {
    return { allowed: false, reason: "malformed E2E Supabase URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `unsupported protocol "${parsed.protocol}"` };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const targetRef = extractProjectRef(input.targetUrl);

  // -- 2. production match blocks FIRST — even when the opt-in is present ---
  for (const prod of input.appProdUrls) {
    if (!prod) continue;
    let prodParsed: URL | null = null;
    try {
      prodParsed = new URL(prod);
    } catch {
      continue;
    }
    if (prodParsed.hostname.toLowerCase() === host) {
      return {
        allowed: false,
        reason: "target matches the application's configured (production) Supabase host",
      };
    }
    const prodRef = extractProjectRef(prod);
    if (prodRef && targetRef && prodRef === targetRef) {
      return {
        allowed: false,
        reason: "target matches the application's configured (production) project ref",
      };
    }
  }

  // -- 3. explicit test-only opt-in -----------------------------------------
  if (input.allowMutation !== "true") {
    return { allowed: false, reason: "ALLOW_E2E_DB_MUTATION is not \"true\"" };
  }

  // -- 4. target allowlist: local, or the dedicated test project ------------
  const localHosts = (input.localHosts ?? ["localhost", "127.0.0.1", "::1"]).map((h) =>
    h.toLowerCase()
  );
  if (localHosts.includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { allowed: true, reason: "local test database" };
  }
  if (
    input.testProjectRef &&
    targetRef &&
    targetRef === input.testProjectRef.trim().toLowerCase()
  ) {
    return { allowed: true, reason: "dedicated E2E test project" };
  }
  return {
    allowed: false,
    reason: `host "${host}" is not an approved local/test database`,
  };
}

/** Production refs to always refuse: process env + the app's .env.local. */
function collectAppProdUrls(): string[] {
  const urls: string[] = [];
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    urls.push(process.env.NEXT_PUBLIC_SUPABASE_URL);
  }
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      if (line.startsWith("NEXT_PUBLIC_SUPABASE_URL=")) {
        urls.push(line.slice(line.indexOf("=") + 1).trim());
      }
    }
  } catch {
    // no .env.local — nothing to add
  }
  return urls;
}

let cached: SupabaseClient | null = null;

/**
 * Collection-safe status of the mutation guard for the CURRENT environment.
 * Reads process env only: it never creates a Supabase client and never
 * throws, so it is safe to call while Playwright collects/tests list.
 * Same fail-closed classification as getE2eAdminClient() (shared code below).
 */
export function e2eDbMutationStatus(): GuardResult {
  const targetUrl = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54331";
  return classifyTestDbTarget({
    targetUrl,
    allowMutation: process.env.ALLOW_E2E_DB_MUTATION,
    testProjectRef: process.env.E2E_TEST_PROJECT_REF,
    appProdUrls: collectAppProdUrls(),
  });
}

/**
 * The ONLY sanctioned way for E2E/test code to obtain a DB-mutating client.
 * Throws (fail-closed) before any insert/update/delete is possible. Must be
 * called from a test lifecycle hook or test body — never at module scope.
 */
export function getE2eAdminClient(): SupabaseClient {
  const targetUrl = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54331";
  const result = e2eDbMutationStatus();
  if (!result.allowed) {
    throw new Error(
      `[e2e-db-guard] test DB mutation refused: ${result.reason} (target: ${targetUrl})`
    );
  }
  const serviceKey = process.env.E2E_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("[e2e-db-guard] E2E_SERVICE_ROLE_KEY is required for test DB mutations");
  }
  if (!cached) {
    cached = createClient(targetUrl, serviceKey, { auth: { persistSession: false } });
  }
  return cached;
}
