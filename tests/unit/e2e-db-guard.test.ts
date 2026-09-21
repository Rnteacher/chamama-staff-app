import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyTestDbTarget,
  extractProjectRef,
  e2eDbMutationStatus,
} from "../../e2e/test-db-guard";

/**
 * Unit tests for the fail-closed E2E DB-mutation guard:
 *   - local/test URL + opt-in            -> allowed
 *   - missing opt-in                     -> blocked
 *   - production project                 -> ALWAYS blocked (even with opt-in)
 *   - malformed/missing URL              -> blocked
 */

const PROD = "https://bgkqpqxeobdmbnewbljq.supabase.co";
const APP_ENV_PROD = "https://bgkqpqxeobdmbnewbljq.supabase.co"; // as in .env.local
const TEST_PROJECT = "abcdefghijkmnopqrstuvabcdefghij";

const base = {
  allowMutation: "true" as string | undefined,
  testProjectRef: undefined as string | undefined,
  appProdUrls: [] as string[],
};

describe("e2e DB-mutation guard (fail-closed)", () => {
  it("allows a LOCAL database URL when the explicit opt-in is present", () => {
    for (const url of [
      "http://127.0.0.1:54331",
      "http://localhost:3000",
      "http://[::1]:54321",
      "http://supabase.local:54321",
    ]) {
      const r = classifyTestDbTarget({ ...base, targetUrl: url });
      expect(r.allowed, url).toBe(true);
    }
  });

  it("allows the DEDICATED test project (ref match) with opt-in", () => {
    const r = classifyTestDbTarget({
      ...base,
      targetUrl: `https://${TEST_PROJECT}.supabase.co`,
      testProjectRef: TEST_PROJECT,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("dedicated E2E test project");
  });

  it("blocks when the opt-in is missing or not exactly true", () => {
    for (const allowMutation of [undefined, "", "1", "TRUE", "yes", "false"]) {
      const r = classifyTestDbTarget({
        ...base,
        targetUrl: "http://127.0.0.1:54331",
        allowMutation,
      });
      expect(r.allowed, String(allowMutation)).toBe(false);
      expect(r.reason).toContain("ALLOW_E2E_DB_MUTATION");
    }
  });

  it("blocks a hosted production project even WITH the opt-in", () => {
    const r = classifyTestDbTarget({
      ...base,
      targetUrl: PROD,
      appProdUrls: [APP_ENV_PROD],
    });
    expect(r.allowed).toBe(false);
  });

  it("blocks the production host/ref even when a test ref was also provided", () => {
    const r = classifyTestDbTarget({
      ...base,
      targetUrl: PROD,
      testProjectRef: TEST_PROJECT, // a real test ref exists, but the target is prod
      appProdUrls: [APP_ENV_PROD],
    });
    expect(r.allowed).toBe(false);
  });

  it("blocks when the target ref matches the app's configured production ref", () => {
    const r = classifyTestDbTarget({
      ...base,
      targetUrl: "https://bgkqpqxeobdmbnewbljq.supabase.co/rest",
      appProdUrls: [APP_ENV_PROD],
    });
    expect(r.allowed).toBe(false);
  });

  it("blocks a production host by allowlist rule even without an app-env match", () => {
    // any non-local, non-dedicated-test host is refused (fail closed)
    const r = classifyTestDbTarget({
      ...base,
      targetUrl: "https://zzzzzzzzzzzzzzzzzzzzzz.supabase.co",
      appProdUrls: [],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not an approved local/test database");
  });

  it("blocks a malformed URL", () => {
    for (const url of ["not a url", "http://", "ftp://x", "javascript:alert(1)"]) {
      const r = classifyTestDbTarget({ ...base, targetUrl: url });
      expect(r.allowed, url).toBe(false);
    }
  });

  it("blocks a missing URL", () => {
    const r = classifyTestDbTarget({ ...base, targetUrl: undefined });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("missing");
  });

  it("blocks even when NODE_ENV=test without the explicit opt-in", () => {
    const r = classifyTestDbTarget({
      ...base,
      targetUrl: "http://127.0.0.1:54331",
      allowMutation: undefined,
    });
    expect(r.allowed).toBe(false);
  });

  it("extracts hosted project refs only", () => {
    expect(extractProjectRef(PROD)).toBe("bgkqpqxeobdmbnewbljq");
    expect(extractProjectRef("http://127.0.0.1:54331")).toBeNull();
    expect(extractProjectRef(undefined)).toBeNull();
    expect(extractProjectRef("garbage")).toBeNull();
  });
});

describe("e2eDbMutationStatus (collection-safe status, never throws, no client)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports BLOCKED without the opt-in — without throwing (safe for collection)", () => {
    vi.stubEnv("E2E_SUPABASE_URL", "http://127.0.0.1:54331");
    vi.stubEnv("ALLOW_E2E_DB_MUTATION", "");
    const status = e2eDbMutationStatus();
    expect(status.allowed).toBe(false);
    expect(status.reason).toContain("ALLOW_E2E_DB_MUTATION");
  });

  it("reports ALLOWED for the local target with the explicit opt-in", () => {
    vi.stubEnv("E2E_SUPABASE_URL", "http://127.0.0.1:54331");
    vi.stubEnv("ALLOW_E2E_DB_MUTATION", "true");
    const status = e2eDbMutationStatus();
    expect(status.allowed).toBe(true);
    expect(status.reason).toBe("local test database");
  });

  it("STILL refuses the application's configured production URL even with the opt-in", () => {
    vi.stubEnv("E2E_SUPABASE_URL", "https://bgkqpqxeobdmbnewbljq.supabase.co");
    vi.stubEnv("ALLOW_E2E_DB_MUTATION", "true");
    // the guard collects production refs from the app env, too
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://bgkqpqxeobdmbnewbljq.supabase.co");
    const status = e2eDbMutationStatus();
    expect(status.allowed).toBe(false);
    expect(status.reason).toContain("production");
  });
});

describe("getE2eAdminClient (factory fails closed)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to hand out a client without the opt-in", async () => {
    vi.stubEnv("E2E_SUPABASE_URL", "http://127.0.0.1:54331");
    vi.stubEnv("ALLOW_E2E_DB_MUTATION", "");
    const { getE2eAdminClient } = await import("../../e2e/test-db-guard");
    expect(() => getE2eAdminClient()).toThrow(/\[e2e-db-guard\]/);
  });

  it("returns a client for the local target with the opt-in and service key", async () => {
    vi.stubEnv("E2E_SUPABASE_URL", "http://127.0.0.1:54331");
    vi.stubEnv("ALLOW_E2E_DB_MUTATION", "true");
    vi.stubEnv("E2E_SERVICE_ROLE_KEY", "test-service-key");
    const { getE2eAdminClient } = await import("../../e2e/test-db-guard");
    const client = getE2eAdminClient();
    expect(client).toBeTruthy();
    expect(typeof client.from).toBe("function");
  });

  it("refuses the application's production URL even with the opt-in set", async () => {
    vi.stubEnv("E2E_SUPABASE_URL", "https://bgkqpqxeobdmbnewbljq.supabase.co");
    vi.stubEnv("ALLOW_E2E_DB_MUTATION", "true");
    vi.stubEnv("E2E_SERVICE_ROLE_KEY", "test-service-key");
    const { getE2eAdminClient } = await import("../../e2e/test-db-guard");
    expect(() => getE2eAdminClient()).toThrow(/production/);
  });
});
