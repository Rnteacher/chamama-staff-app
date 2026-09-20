import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Regression tests for the six production-visible failures:
 *   1. desktop home order (updates ABOVE the student table)
 *   2. duplicate student search on desktop
 *   3. weekly meeting delete (עריכה + מחיקה)
 *   4. ordinary student update edit/delete
 *   5. admin home activity log (לוג פעילות, no מצב תצורה)
 *   6. public intake list disappeared (broken PostgREST select)
 */

vi.mock("server-only", () => ({}));

const src = (p: string) =>
  readFileSync(path.resolve(__dirname, "../../src", p), "utf8");
const migration = (name: string) =>
  readFileSync(
    path.resolve(__dirname, "../../supabase/migrations", name),
    "utf8"
  );

// ============================================================ 1. HOME ORDER ==
describe("1. desktop home order", () => {
  const home = src("app/(app)/page.tsx");

  it("renders the unread-updates section BEFORE the desktop student table", () => {
    const updatesIdx = home.indexOf('aria-labelledby="unread-heading"');
    const tableIdx = home.indexOf('title="כל החניכים"');
    expect(updatesIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(-1);
    expect(updatesIdx).toBeLessThan(tableIdx);
  });

  it("desktop dashboards are hidden on mobile (single source, no duplication)", () => {
    expect(home).toMatch(/className="hidden flex-col gap-6 lg:flex"/);
  });
});

// ======================================================= 2. DUPLICATE SEARCH ==
describe("2. duplicate student search", () => {
  const home = src("app/(app)/page.tsx");
  const table = src("components/tables/StudentDataTable.tsx");

  it("home global-search entry is hidden on desktop (lg:hidden)", () => {
    const linkBlock = home.slice(
      home.indexOf('href="/search"'),
      home.indexOf("</Link>", home.indexOf('href="/search"'))
    );
    expect(linkBlock).toContain("lg:hidden");
  });

  it("the StudentDataTable search toolbar is the single desktop student search", () => {
    expect(table).toMatch(/type="search"/);
    expect(table).toMatch(/חיפוש חניך/);
    // exactly one search input rendered per table
    expect(table.match(/type="search"/g)).toHaveLength(1);
  });
});

// ============================================== 3. WEEKLY MEETING DELETE =====
describe("3. weekly meeting delete", () => {
  const panel = src("components/meetings/StudentMeetingsPanel.tsx");
  const actions = src("lib/actions/meetings.ts");
  const studentPage = src("app/(app)/students/[id]/page.tsx");

  it("every owned schedule row shows both עריכה and מחיקה", () => {
    expect(panel).toMatch(/עריכה\s*<\/button>/);
    expect(panel).toMatch(/מחיקה\s*<\/button>/);
    expect(panel).toContain("deletingScheduleId"); // confirmation flow
  });

  it("uses the safe deactivate behavior (soft deactivate RPC)", async () => {
    expect(panel).toContain("deactivateMeetingScheduleAction");
    const fn = actions.slice(actions.indexOf("deactivateMeetingScheduleAction"));
    expect(fn).toContain('"deactivate_meeting_schedule"');
    expect(fn).toContain("assertNotViewAs"); // blocked in View-As
  });

  it("refreshes the UI immediately after deletion", () => {
    const deleteFlow = panel.slice(
      panel.indexOf("deactivateMeetingScheduleAction")
    );
    expect(deleteFlow).toContain("router.refresh()");
  });

  it("student page passes isSuper to the meetings panel", () => {
    expect(studentPage).toMatch(/StudentMeetingsPanel[\s\S]*isSuper=\{isSuper\}/);
  });
});

// ======================================= 4. ORDINARY STUDENT UPDATE EDIT/DEL ==
describe("4. ordinary student update edit/delete", () => {
  const feed = src("components/feed/UnifiedUpdatesFeed.tsx");
  const messages = src("lib/actions/messages.ts");
  const studentPage = src("app/(app)/students/[id]/page.tsx");

  it("feed imports both edit and delete message actions", () => {
    expect(feed).toContain("editMessageAction");
    expect(feed).toContain("deleteMessageAction");
  });

  it("mutation controls are author-gated and hidden in View-As", () => {
    const gate = feed.slice(
      feed.indexOf("{!readOnly && (item.author_staff_id === currentStaffId"),
      feed.indexOf("MessageEditDelete", feed.indexOf("{!readOnly && (item.author_staff_id === currentStaffId"))
    );
    expect(gate).toContain("isSuperAdmin");
    expect(feed).toMatch(/readOnly=\{viewAs\.active\}|readOnly = false/);
  });

  it("student page feeds server-derived identity into the feed", () => {
    expect(studentPage).toContain("currentStaffId={me.staffId}");
    expect(studentPage).toContain("author_staff_id: r.author_staff_id ?? null");
  });

  it("edit never changes the author (body-only update) and is View-As guarded", () => {
    const editFn = messages.slice(
      messages.indexOf("export async function editMessageAction"),
      messages.indexOf("export async function markMessagesReadAction")
    );
    expect(editFn).toMatch(/\.update\(\{\s*body:/);
    expect(editFn).not.toMatch(/update\(\{[^}]*author/);
    expect(editFn).toContain("assertNotViewAs");
  });

  it("delete is a server-side soft-delete RPC (author or super_admin) with audit", () => {
    expect(messages).toContain('"delete_student_message"');
    const mig = migration(
      "20260921000002_message_edit_audit_and_feed_author.sql"
    );
    expect(mig).toContain("deleted_at is null"); // excluded from normal feed
    expect(mig).toMatch(/student_message_deleted/); // audited
    expect(mig).toMatch(/trg_audit_message_body_edit/); // edit audited
    expect(mig).toMatch(/author_staff_id uuid/); // feed exposes author
  });
});

// ================================================= 5. ADMIN ACTIVITY LOG =====
describe("5. admin home activity log", () => {
  const admin = src("app/(app)/admin/page.tsx");
  const mig = migration(
    "20260921000002_message_edit_audit_and_feed_author.sql"
  );

  it("renders לוג פעילות and does NOT render מצב תצורה", () => {
    expect(admin).toContain("לוג פעילות");
    expect(admin).not.toContain("מצב התצורה");
    expect(admin).not.toContain("hasVapidConfig");
  });

  it("reads the existing audit_logs through a safe RPC, newest first", () => {
    expect(admin).toContain('"recent_audit_logs"');
    expect(mig).toMatch(/order by l\.created_at desc/);
    expect(mig).toMatch(/security definer/);
    // server authorization: coordinator/super_admin only
    expect(mig).toMatch(/staff_has_role\(public\.current_staff_id\(\), 'super_admin'\)/);
    expect(mig).toMatch(/staff_has_role\(public\.current_staff_id\(\), 'project_coordinator'\)/);
  });

  it("does not expose sensitive report contents (safe columns only)", () => {
    const fn = mig.slice(
      mig.indexOf("create or replace function public.recent_audit_logs")
    );
    expect(fn).toContain("actor_name");
    expect(fn).not.toMatch(/\bbody\b/);
  });
});

// ====================================================== 6. INTAKE LIST =======
describe("6. public intake list", () => {
  const page = src("app/(app)/admin/intake/page.tsx");
  const manager = src("components/admin/IntakeManager.tsx");

  it("does NOT use the invalid PostgREST select expression", () => {
    expect(page).not.toContain("IS NOT NULL as has_recoverable_link");
    expect(page).not.toContain("has_recoverable_link");
  });

  it("selects encrypted_token server-side and maps a boolean only", () => {
    expect(page).toContain("encrypted_token");
    expect(page).toMatch(/hasRecoverableLink\s*=|hasRecoverableLink,/);
    // the browser-facing row type has no token material
    const rowType = page.slice(
      page.indexOf("const row = w as unknown as"),
      page.indexOf("return {")
    );
    expect(rowType).toContain("encrypted_token: string | null");
    const returned = page.slice(page.indexOf("return {"), page.indexOf("createdByName"));
    expect(returned).not.toContain("encryption_iv");
    expect(returned).not.toContain("encryption_tag");
  });

  it("does not swallow the query error", () => {
    expect(page).toMatch(/if \(windowsRes\.error\)/);
    expect(page).toMatch(/throw new Error/);
  });

  it("shows the correct action per link type", () => {
    expect(manager).toMatch(/w\.hasRecoverableLink \? \(/);
    expect(manager).toContain("ReissueButton");
    expect(manager).toContain("העתקת קישור");
    expect(manager).toContain("יצירת קישור נוסף");
  });

  it("management list hides only soft-deleted windows", () => {
    expect(page).toMatch(/\.is\("deleted_at", null\)/);
    expect(page).not.toMatch(/\.eq\("is_revoked", false/);
  });
});

// ============== behavior: deleteMessageAction (View-As + RPC + revalidate) ===

// vi.mock is hoisted — drive behavior through this top-level state holder
const behavior = vi.hoisted(() => ({
  viewAs: false,
  rpcError: null as { message: string } | null,
  hasStudentRow: true,
  studentId: "student-9",
  rpc: null as unknown as ReturnType<typeof vi.fn>,
  revalidateCalls: [] as string[],
  revalidatePath: null as unknown as (p: string) => void,
}));

vi.mock("@/lib/auth", () => ({
  requireMe: vi.fn(async () => ({ staffId: "staff-1", roles: ["staff"] })),
}));
vi.mock("@/lib/view-as", () => ({
  assertNotViewAs: vi.fn(async () => !behavior.viewAs),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc: behavior.rpc })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: behavior.hasStudentRow
              ? { student_id: behavior.studentId }
              : null,
          })),
        })),
      })),
    })),
  })),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => behavior.revalidatePath(p),
}));

describe("deleteMessageAction behavior", () => {
  beforeEach(async () => {
    behavior.viewAs = false;
    behavior.rpcError = null;
    behavior.hasStudentRow = true;
    behavior.studentId = "student-9";
    behavior.rpc = vi.fn(async () => ({
      data: behavior.rpcError ? null : true,
      error: behavior.rpcError,
    }));
    behavior.revalidateCalls = [];
    behavior.revalidatePath = vi.fn((p: string) => {
      behavior.revalidateCalls.push(p);
    });
  });

  async function loadAction() {
    const { deleteMessageAction } = await import("@/lib/actions/messages");
    return deleteMessageAction;
  }

  it("blocks deletion in View-As mode", async () => {
    behavior.viewAs = true;
    const deleteMessageAction = await loadAction();
    const res = await deleteMessageAction("11111111-1111-1111-1111-111111111111");
    expect(res.ok).toBe(false);
    expect(behavior.rpc).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id without touching the DB", async () => {
    const deleteMessageAction = await loadAction();
    const res = await deleteMessageAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(behavior.rpc).not.toHaveBeenCalled();
  });

  it("calls the RPC and revalidates the student page", async () => {
    const deleteMessageAction = await loadAction();
    const ok = await deleteMessageAction("11111111-1111-1111-1111-111111111111");
    expect(ok.ok).toBe(true);
    expect(behavior.rpc).toHaveBeenCalledWith("delete_student_message", {
      p_message_id: "11111111-1111-1111-1111-111111111111",
    });
    const paths = behavior.revalidateCalls;
    expect(paths).toContain("/students/student-9");
    expect(paths).toContain("/updates");
  });

  it("maps ownership errors to a friendly message", async () => {
    behavior.rpcError = { message: "Message not found or not yours" };
    const deleteMessageAction = await loadAction();
    const fail = await deleteMessageAction("11111111-1111-1111-1111-111111111112");
    expect(fail).toEqual({ ok: false, error: "רק מחבר ההודעה רשאי למחוק אותה" });
  });
});
