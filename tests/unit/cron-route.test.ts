import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Route-level auth behavior for the meeting-reminders dispatcher.
 * The route's own Bearer check runs BEFORE any database access, so:
 *  - missing/wrong token → 401 without touching the database
 *  - valid token but missing service key → passes auth, fails closed on
 *    server configuration (500 "dispatcher failed")
 *
 * The Supabase server module is mocked (it is `server-only` and would refuse
 * to load in a unit test); the Supabase URL is pointed at an unroutable local
 * port so any accidental network access fails instantly and deterministically.
 */

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }),
  createClient: vi.fn(),
}));

vi.mock("@/lib/push/send", () => ({
  sendPushToUsers: vi.fn(async () => ({})),
}));

const CRON_PATH = "/api/cron/meeting-reminders";

function req(auth?: string): Request {
  return new Request(`http://localhost:3000${CRON_PATH}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

async function importRoute() {
  // dynamic import AFTER env stubbing + module mocking
  const mod = await import("@/app/api/cron/meeting-reminders/route");
  return mod.GET;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:9");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  // no SUPABASE_SERVICE_ROLE_KEY stub → dispatcher fails closed after auth
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("meeting-reminders route auth", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    const GET = await importRoute();
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 for a wrong Bearer token", async () => {
    const GET = await importRoute();
    const res = await GET(req("Bearer wrong-token"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 500 (misconfig, fail-closed) when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", ""); // unset
    const GET = await importRoute();
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "CRON_SECRET is not configured" });
  });

  it("a valid token passes auth and reaches the dispatcher (fails closed on missing service key)", async () => {
    const GET = await importRoute();
    const res = await GET(req("Bearer test-cron-secret"));
    // auth passed → the handler proceeded to the dispatcher, which failed
    // closed because SUPABASE_SERVICE_ROLE_KEY is not set in this test env.
    // The important assertions: NOT 401, NOT a /login redirect, and the
    // secret is never echoed back.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("dispatcher failed");
    expect(JSON.stringify(body)).not.toContain("test-cron-secret");
  });
});
