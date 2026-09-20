import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * BEHAVIORAL tests for intake links & lifecycle:
 *  - "יצירת קישור נוסף" ADDS a recoverable token; the legacy token stays valid
 *  - Copy Link returns the SAME URL repeatedly and never mutates the DB
 *  - reactivate clears the disabled state without touching tokens
 *  - delete is hard for empty windows and soft (deleted_at) for windows
 *    with submissions; always audited; blocked in View-As
 */

const state = vi.hoisted(() => ({
  viewAs: false,
  coordinator: true,
  windowRow: null as Record<string, unknown> | null,
  childTokens: [] as Array<Record<string, string>>,
  submissionCount: 0,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  deletes: [] as string[],
  updatedTokenHash: null as string | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  requireMe: vi.fn(async () => ({ staffId: "11111111-1111-1111-1111-111111111101", roles: ["project_coordinator"] })),
  hasRole: vi.fn(() => state.coordinator),
}));
vi.mock("@/lib/view-as", () => ({
  assertNotViewAs: vi.fn(async () => !state.viewAs),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "intake_submissions") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ count: state.submissionCount, error: null }),
          }),
        };
      }
      if (table === "intake_window_tokens") {
        return {
          select: () => {
            const chain = {
              eq: () => chain,
              is: () => chain,
              not: () => chain,
              order: () => chain,
              limit: () => Promise.resolve({ data: state.childTokens, error: null }),
            };
            return chain;
          },
          insert: vi.fn((row: Record<string, unknown>) => {
            state.inserts.push({ table, row });
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }
      if (table === "intake_windows") {
        return {
          select: () => {
            const chain = {
              eq: () => chain,
              is: () => chain,
              maybeSingle: async () => ({ data: state.windowRow, error: null }),
            };
            return chain;
          },
          update: vi.fn((patch: Record<string, unknown>) => {
            state.updates.push(patch);
            if ("token_hash" in patch) state.updatedTokenHash = patch.token_hash as string;
            const b = { eq: () => Promise.resolve({ data: null, error: null }) };
            return b;
          }),
          delete: vi.fn(() => {
            state.deletes.push("intake_windows");
            const b = { eq: () => Promise.resolve({ data: null, error: null }) };
            return b;
          }),
        };
      }
      // audit_logs
      return {
        insert: vi.fn((row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        }),
      };
    }),
  })),
  createClient: vi.fn(async () => ({})),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  copyIntakeLinkAction,
  reissueIntakeTokenAction,
  restoreIntakeWindowAction,
  deleteIntakeWindowAction,
} from "@/lib/actions/intake";

vi.stubEnv("INTAKE_TOKEN_ENCRYPTION_KEY", "a".repeat(64));

const W = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const URL_ORIGINAL = "http://localhost:3000/intake/original-raw-token";

function reset(opts: Partial<typeof state> = {}) {
  state.viewAs = false;
  state.coordinator = true;
  state.windowRow = { id: W };
  state.childTokens = [];
  state.submissionCount = 0;
  state.updates = [];
  state.inserts = [];
  state.deletes = [];
  state.updatedTokenHash = null;
  Object.assign(state, opts);
}

describe("Case A — recoverable window token", () => {
  beforeEach(() => reset());

  it("Copy Link returns the SAME URL on repeated clicks and never mutates the DB", async () => {
    const { encryptToken } = await import("@/lib/intake-crypto");
    const enc = encryptToken("original-raw-token");
    state.windowRow = {
      encrypted_token: enc.encrypted,
      encryption_iv: enc.iv,
      encryption_tag: enc.tag,
    };

    const r1 = await copyIntakeLinkAction(W);
    const r2 = await copyIntakeLinkAction(W);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.url).toBe(r2.url);
    expect(r1.url).toContain("original-raw-token");
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
    expect(state.deletes).toHaveLength(0);
  });

  it("newly created windows store encrypted token material (creation path check)", () => {
    // the create action writes encrypted_token + iv + tag (no plaintext at rest)
    const createSrc = readFileSync(
      path.resolve(__dirname, "../../src/lib/actions/intake.ts"),
      "utf8"
    );
    expect(createSrc).toMatch(/encryptToken\(token\)/);
    expect(createSrc).toMatch(/encrypted_token: enc\.encrypted/);
    expect(createSrc).toMatch(/encryption_iv: enc\.iv/);
  });
});

describe("Case B — legacy hash-only token: additional link, never replacement", () => {
  beforeEach(() => reset());

  it("adds a recoverable child token WITHOUT touching the legacy token_hash", async () => {
    const res = await reissueIntakeTokenAction(W);
    expect(res.ok).toBe(true);
    expect(state.inserts.some((i) => i.table === "intake_window_tokens")).toBe(true);
    const row = state.inserts.find((i) => i.table === "intake_window_tokens")!.row;
    expect(row.intake_window_id).toBe(W);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.encrypted_token).toMatch(/^[0-9a-f]+$/);
    // legacy token untouched
    expect(state.updates).toHaveLength(0);
    expect(state.updatedTokenHash).toBeNull();
    // audited as an ADDITION
    expect(
      state.inserts.some(
        (i) => i.table === "audit_logs" && i.row.action === "intake_token_added"
      )
    ).toBe(true);
  });

  it("after the additional link exists, Copy Link decrypts the child token", async () => {
    const { encryptToken } = await import("@/lib/intake-crypto");
    const enc = encryptToken("additional-raw-token");
    reset({
      childTokens: [{ encrypted_token: enc.encrypted, encryption_iv: enc.iv, encryption_tag: enc.tag }],
    });
    const res = await copyIntakeLinkAction(W);
    expect(res.ok).toBe(true);
    expect(res.url).toContain("additional-raw-token");
    expect(state.updates).toHaveLength(0);
  });

  it("returns needsReissue when no recoverable material exists", async () => {
    const res = await copyIntakeLinkAction(W);
    expect(res.ok).toBe(false);
    expect(res.needsReissue).toBe(true);
  });

  it("the migration stores only hashes + ciphertext (no plaintext token column)", () => {
    const mig = readFileSync(
      path.resolve(
        __dirname,
        "../../supabase/migrations/20260921000003_read_state_intake_tokens_dashboard_major.sql"
      ),
      "utf8"
    );
    expect(mig).toMatch(/create table if not exists public\.intake_window_tokens/);
    expect(mig).toMatch(/token_hash\s+text not null unique/);
    expect(mig).not.toMatch(/^[ \t]*token[ \t]+text/m);
    expect(mig).toMatch(/revoke all on public\.intake_window_tokens from authenticated, anon/);
    // legacy window lookup still accepted
    expect(mig).toMatch(/w\.token_hash = encode\(sha256/);
    // additional tokens accepted with their own revoked state
    expect(mig).toMatch(/t\.revoked_at is null/);
  });
});

describe("disable / reactivate / delete lifecycle", () => {
  beforeEach(() => reset());

  function fd(id: string = W) {
    const f = new FormData();
    f.set("id", id);
    return f;
  }

  it("reactivate clears the disabled state without touching tokens", async () => {
    const res = await restoreIntakeWindowAction(null, fd());
    expect(res.ok).toBe(true);
    expect(state.updates[0]).toMatchObject({ is_revoked: false });
    expect(state.updates[0].token_hash).toBeUndefined();
    expect(
      state.inserts.some(
        (i) => i.table === "audit_logs" && i.row.action === "intake_window_restored"
      )
    ).toBe(true);
  });

  it("hard-deletes an empty window", async () => {
    state.submissionCount = 0;
    const res = await deleteIntakeWindowAction(null, fd());
    expect(res.ok).toBe(true);
    expect(state.deletes).toContain("intake_windows");
    expect(state.updates).toHaveLength(0);
    expect(
      state.inserts.some(
        (i) =>
          i.table === "audit_logs" &&
          i.row.action === "intake_window_deleted" &&
          (i.row.metadata as Record<string, string>).mode === "hard"
      )
    ).toBe(true);
  });

  it("soft-deletes a window WITH submissions (history preserved)", async () => {
    state.submissionCount = 3;
    const res = await deleteIntakeWindowAction(null, fd());
    expect(res.ok).toBe(true);
    expect(state.deletes).toHaveLength(0);
    expect(state.updates[0].deleted_at).toBeTruthy();
    expect(
      state.inserts.some(
        (i) =>
          i.table === "audit_logs" &&
          i.row.action === "intake_window_deleted" &&
          (i.row.metadata as Record<string, string>).mode === "soft"
      )
    ).toBe(true);
  });

  it("blocks every lifecycle mutation in View-As mode", async () => {
    state.viewAs = true;
    expect((await restoreIntakeWindowAction(null, fd())).ok).toBe(false);
    expect((await deleteIntakeWindowAction(null, fd())).ok).toBe(false);
    expect((await reissueIntakeTokenAction(W)).ok).toBe(false);
    expect(state.updates).toHaveLength(0);
    expect(state.deletes).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects invalid ids", async () => {
    expect((await restoreIntakeWindowAction(null, fd("nope"))).ok).toBe(false);
    expect((await deleteIntakeWindowAction(null, fd("nope"))).ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });
});
