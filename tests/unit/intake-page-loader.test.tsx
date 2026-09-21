import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * INTEGRATION test for the /admin/intake page loader:
 * the exact production query path (user client for base data + authorized
 * service-role read of intake_window_tokens) returns successfully and the
 * existing intake rows RENDER — with no encrypted material in the DOM.
 */

const state = vi.hoisted(() => ({
  windowRow: {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    title: "הצהרות כוונות — מחזור תשפ״ו",
    opens_at: "2026-01-01T00:00:00Z",
    closes_at: "2026-12-31T00:00:00Z",
    is_revoked: false,
    created_at: "2026-01-01T00:00:00Z",
    encrypted_token: null,
    profiles: { full_name: "רונן אדמיניסטרטור" },
  },
  childTokens: [{ intake_window_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", encrypted_token: "deadbeef", revoked_at: null }],
  submissions: [],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("REDIRECT"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({
  requireMe: vi.fn(async () => ({ staffId: "11111111-1111-1111-1111-111111111101", roles: ["super_admin"], fullName: "רונן" })),
  hasRole: vi.fn(() => true),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: { data: unknown; error: null }) => void) =>
          Promise.resolve({ data: table === "intake_windows" ? [state.windowRow] : [], error: null }).then(resolve),
      };
      return chain;
    }),
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      expect(table).toBe("intake_window_tokens");
      const chain = {
        select: () => chain,
        in: () => chain,
        then: (resolve: (v: { data: unknown; error: null }) => void) =>
          Promise.resolve({ data: state.childTokens, error: null }).then(resolve),
      };
      return chain;
    }),
  })),
}));
vi.mock("@/lib/actions/intake", () => ({
  createIntakeWindowAction: vi.fn(),
  revokeIntakeWindowAction: vi.fn(),
  restoreIntakeWindowAction: vi.fn(),
  deleteIntakeWindowAction: vi.fn(),
  assignMasterFromIntakeAction: vi.fn(),
  copyIntakeLinkAction: vi.fn(),
  reissueIntakeTokenAction: vi.fn(),
}));

import AdminIntakePage from "@/app/(app)/admin/intake/page";

describe("/admin/intake page loader", () => {
  beforeEach(() => {
    state.childTokens = [{ intake_window_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", encrypted_token: "deadbeef", revoked_at: null }];
  });

  it("loads successfully and renders the existing intake row (no crash)", async () => {
    const element = await AdminIntakePage();
    const html = renderToStaticMarkup(<>{element}</>);
    expect(html).toContain("טפסי קבלה ציבוריים");
    expect(html).toContain("הצהרות כוונות — מחזור תשפ״ו"); // existing row renders
    expect(html).toContain("יצוא CSV");
    expect(html).not.toContain("משהו השתבש");
  });

  it("shows העתקת קישור for a recoverable window (child token via service role)", async () => {
    const element = await AdminIntakePage();
    const html = renderToStaticMarkup(<>{element}</>);
    expect(html).toContain("העתקת קישור");
  });

  it("never leaks encrypted token material into the rendered page", async () => {
    const element = await AdminIntakePage();
    const html = renderToStaticMarkup(<>{element}</>);
    expect(html).not.toContain("deadbeef");
    expect(html).not.toContain("encrypted_token");
    expect(html).not.toContain("encryption_iv");
  });

  it("legacy window (no tokens anywhere) renders יצירת קישור נוסף", async () => {
    state.childTokens = [];
    state.windowRow = { ...state.windowRow, encrypted_token: null };
    const element = await AdminIntakePage();
    const html = renderToStaticMarkup(<>{element}</>);
    expect(html).toContain("יצירת קישור נוסף");
  });
});
