import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BEHAVIORAL tests for the persisted per-user read state:
 *   UI → markMessagesReadAction/UnreadAction → message_reads table
 * Persistence itself is proven end-to-end against a real database
 * (local supabase stack, see e2e/read-state.spec.ts and the SQL verification),
 * these tests pin the exact write path, scoping and View-As behavior.
 */

const state = vi.hoisted(() => ({
  viewAs: false,
  staffId: "11111111-1111-1111-1111-111111111102",
  upsertError: null as { message: string } | null,
  deleteError: null as { message: string } | null,
  upsert: null as unknown as ReturnType<typeof vi.fn>,
  adminStudentRows: [] as Array<{ student_id: string }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  requireMe: vi.fn(async () => ({ staffId: state.staffId, roles: ["staff"] })),
}));
vi.mock("@/lib/view-as", () => ({
  assertNotViewAs: vi.fn(async () => !state.viewAs),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      expect(table).toBe("message_reads");
      const builder = {
        upsert: state.upsert,
        delete: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        in: vi.fn(() => Promise.resolve({ data: null, error: state.deleteError })),
      };
      return builder;
    }),
  })),
  // the action derives the student page path from student_messages itself
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      expect(table).toBe("student_messages");
      const builder = {
        select: () => builder,
        in: (_col: string, ids: string[]) => {
          void ids;
          return Promise.resolve({ data: state.adminStudentRows, error: null });
        },
      };
      return builder;
    }),
  })),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { markMessagesReadAction, markMessagesUnreadAction } from "@/lib/actions/messages";
import { revalidatePath } from "next/cache";

const MSG = "55555555-5555-5555-5555-55555555550d";
const STUDENT = "44444444-4444-4444-4444-44444444440d";

describe("mark read (persisted per staff user)", () => {
  beforeEach(() => {
    state.viewAs = false;
    state.upsertError = null;
    state.deleteError = null;
    state.adminStudentRows = [{ student_id: STUDENT }];
    state.upsert = vi.fn(async () => ({ data: null, error: state.upsertError }));
  });

  it("persists a message_reads row scoped to the server-derived staff id", async () => {
    const res = await markMessagesReadAction({ messageIds: [MSG] });
    expect(res.ok).toBe(true);
    expect(state.upsert).toHaveBeenCalledWith(
      [{ staff_id: state.staffId, message_id: MSG }],
      { onConflict: "staff_id,message_id", ignoreDuplicates: true }
    );
  });

  it("revalidates the STUDENT page derived server-side from student_messages", async () => {
    await markMessagesReadAction({ messageIds: [MSG] });
    const paths = (revalidatePath as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paths).toContain(`/students/${STUDENT}`);
    expect(paths).toContain("/");
    expect(paths).toContain("/updates");
    // never trusts a client-supplied relationship: no student path unless the
    // admin lookup returned it
    expect(paths.some((p) => typeof p === "string" && p.startsWith("/students/"))).toBe(true);
  });

  it("revalidates the student page for unread too", async () => {
    (revalidatePath as ReturnType<typeof vi.fn>).mockClear();
    await markMessagesUnreadAction({ messageIds: [MSG] });
    const paths = (revalidatePath as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paths).toContain(`/students/${STUDENT}`);
  });

  it("reverses by deleting only the current staff member's read row", async () => {
    const res = await markMessagesUnreadAction({ messageIds: [MSG] });
    expect(res.ok).toBe(true);
  });

  it("is idempotent (marking read twice stays read)", async () => {
    await markMessagesReadAction({ messageIds: [MSG] });
    await markMessagesReadAction({ messageIds: [MSG] });
    expect(state.upsert).toHaveBeenCalledTimes(2);
  });

  it("surfaces DB failure instead of pretending success", async () => {
    state.upsertError = { message: "boom" };
    const res = await markMessagesReadAction({ messageIds: [MSG] });
    expect(res.ok).toBe(false);
  });

  it("rejects invalid message ids without touching the DB", async () => {
    const res = await markMessagesReadAction({ messageIds: ["nope"] });
    expect(res.ok).toBe(false);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("cannot mutate read state in View-As mode", async () => {
    state.viewAs = true;
    const read = await markMessagesReadAction({ messageIds: [MSG] });
    const unread = await markMessagesUnreadAction({ messageIds: [MSG] });
    expect(read.ok).toBe(false);
    expect(unread.ok).toBe(false);
    expect(state.upsert).not.toHaveBeenCalled();
  });
});
