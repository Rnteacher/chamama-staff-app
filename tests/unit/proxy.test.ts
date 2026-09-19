import { describe, it, expect, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";

/**
 * Proxy behavior for the cron exemption + staff-auth invariants.
 * Env is stubbed BEFORE importing @/proxy (module-level constants), and the
 * Supabase URL points at an unroutable local port: with no session cookies
 * getUser() fails fast locally and signed-out users are redirected without
 * any real network access.
 */
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:9");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");

let proxyFn: (request: NextRequest) => Promise<Response>;

beforeAll(async () => {
  const mod = await import("@/proxy");
  proxyFn = mod.proxy;
});

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

describe("proxy: cron exemption", () => {
  it("does NOT redirect /api/cron/meeting-reminders to /login", async () => {
    const res = await proxyFn(req("/api/cron/meeting-reminders"));
    expect(res.status).toBe(200); // passes through to the route handler
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
  });

  it("does NOT redirect the cron route even with a ?query present", async () => {
    const res = await proxyFn(req("/api/cron/meeting-reminders?x=1"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy: staff-auth invariants preserved", () => {
  it("still redirects signed-out users from /students/[id] to /login", async () => {
    const res = await proxyFn(
      req("/students/44444444-4444-4444-4444-444444444401")
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fstudents%2F44444444-4444-4444-4444-444444444401"
    );
  });

  it("still redirects signed-out users from unrelated authenticated pages", async () => {
    const res = await proxyFn(req("/updates"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fupdates"
    );
  });

  it("still protects the admin section", async () => {
    const res = await proxyFn(req("/admin/staff"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fadmin%2Fstaff"
    );
  });
});
