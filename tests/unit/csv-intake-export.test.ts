import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BEHAVIORAL tests for the CSV export endpoint:
 * a specific intakeId is REQUIRED and the export contains ONLY the selected
 * intake's submissions — never another intake's rows.
 */

const state = vi.hoisted(() => ({
  viewAs: false,
  coordinator: true,
  intakeIdEq: "" as string,
  windows: [] as Array<{ id: string; title: string }>,
  submissionsByIntake: {} as Record<string, Array<Record<string, unknown>>>,
  primaryMasters: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  requireMe: vi.fn(async () => ({ staffId: "11111111-1111-1111-1111-111111111101", roles: ["project_coordinator"] })),
  hasRole: vi.fn((_me: unknown, role: string) =>
    state.coordinator ? role === "project_coordinator" || role === "super_admin" : false
  ),
}));
vi.mock("@/lib/view-as", () => ({
  assertNotViewAs: vi.fn(async () => !state.viewAs),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (table === "intake_submissions" && col === "intake_id") state.intakeIdEq = val;
          if (table !== "intake_submissions") b.lastEq = `${col}=${val}`;
          return chain;
        },
        is: () => chain,
        order: () => chain,
        maybeSingle: async () => ({
          data: table === "intake_windows" ? (state.windows[0] ?? null) : null,
          error: null,
        }),
        then: (
          resolve: (v: { data: unknown; error: null }) => void,
          reject: (e: unknown) => void
        ) => {
          const data =
            table === "intake_submissions"
              ? (state.submissionsByIntake[state.intakeIdEq] ?? [])
              : table === "master_assignments"
                ? state.primaryMasters
                : [];
          Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      void b;
      return chain;
    }),
  })),
}));

import { GET } from "@/app/(app)/admin/intake/export/route";

const INTAKE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INTAKE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function seed() {
  state.windows = [{ id: INTAKE_A, title: "טופס א" }];
  state.intakeIdEq = "";
  state.primaryMasters = [];
  state.submissionsByIntake = {
    [INTAKE_A]: [
      {
        id: "11111111-aaaa-aaaa-aaaa-111111111111",
        intent_text: "רוצה לעבוד על גינה קהילתית",
        updated_at: "2026-01-01T00:00:00Z",
        students: { id: "s-a", first_name: "מאיה", last_name: "דרורי", greenhouse_groups: { name: "קבוצת זית" } },
        majors: { name: "התחדשות עירונית" },
        assigned: { full_name: "נעמה לוי" },
      },
    ],
    [INTAKE_B]: [
      {
        id: "22222222-bbbb-bbbb-bbbb-222222222222",
        intent_text: "רוצה לעבוד על רובוט",
        updated_at: "2026-01-02T00:00:00Z",
        students: { id: "s-b", first_name: "נועם", last_name: "אבידן", greenhouse_groups: { name: "קבוצת ענבים" } },
        majors: { name: "תוכנה" },
        assigned: { full_name: "מיכל כהן" },
      },
    ],
  };
}

function get(intakeId?: string) {
  const url = new URL("http://localhost/admin/intake/export");
  if (intakeId !== undefined) url.searchParams.set("intakeId", intakeId);
  return GET(new Request(url));
}

describe("CSV export requires and scopes to ONE intake", () => {
  beforeEach(() => {
    state.viewAs = false;
    state.coordinator = true;
    seed();
  });

  it("400 when intakeId is missing", async () => {
    const res = await get(undefined);
    expect(res.status).toBe(400);
  });

  it("400 when intakeId is not a uuid", async () => {
    const res = await get("not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("404 when the intake window does not exist", async () => {
    state.windows = [];
    const res = await get("cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(res.status).toBe(404);
  });

  it("403 for non-coordinator staff", async () => {
    state.coordinator = false;
    const res = await get(INTAKE_A);
    expect(res.status).toBe(403);
  });

  it("403 in View-As mode", async () => {
    state.viewAs = true;
    const res = await get(INTAKE_A);
    expect(res.status).toBe(403);
  });

  it("exports intake A with only A's rows — never B", async () => {
    const res = await get(INTAKE_A);
    expect(res.status).toBe(200);
    expect(state.intakeIdEq).toBe(INTAKE_A);
    // UTF-8 BOM preserved (check bytes first; text() would strip the BOM)
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("מאיה דרורי");
    expect(text).toContain("קבוצת זית");
    expect(text).toContain("רוצה לעבוד על גינה קהילתית");
    expect(text).toContain("נעמה לוי");
    expect(text).not.toContain("נועם אבידן");
    expect(text).not.toContain("רובוט");
    expect(text).not.toContain("קבוצת ענבים");
    // headers preserved
    expect(text).toContain("שם החניך,קבוצה,מגמה,הצהרת כוונות ראשונית,מאסטר משובץ");
  });

  it("exports intake B with only B's rows — never A", async () => {
    state.windows = [{ id: INTAKE_B, title: "טופס ב" }];
    const res = await get(INTAKE_B);
    expect(res.status).toBe(200);
    expect(state.intakeIdEq).toBe(INTAKE_B);
    const text = await res.text();
    expect(text).toContain("נועם אבידן");
    expect(text).not.toContain("מאיה דרורי");
    expect(text).not.toContain("גינה קהילתית");
  });

  it("mitigates formula injection in exported cells", async () => {
    state.submissionsByIntake[INTAKE_A][0].intent_text = "=SUM(A1:A2)";
    const res = await get(INTAKE_A);
    const text = await res.text();
    expect(text).toContain("'=SUM(A1:A2)");
  });
});
