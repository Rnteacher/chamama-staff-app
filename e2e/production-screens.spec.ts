import { test, expect } from "@playwright/test";
import { SKIP, USERS, login, logout, requireEmailAuth } from "./helpers";
import { getE2eAdminClient, e2eDbMutationStatus } from "./test-db-guard";

/**
 * Production-screen verification for the three reported failures:
 *   A. desktop home table renders the student's major NAME
 *   C. /admin/intake loads (no "משהו השתבש") and renders intake rows
 * (B — student-page read/unread with reloads — lives in read-state.spec.ts)
 *
 * This spec SEEDS data directly: all mutations go through the fail-closed
 * e2e-db-guard (local/test target + explicit ALLOW_E2E_DB_MUTATION=true).
 */
test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

// ---------------------------------------------------------------------------
// Collection-safe structure:
//   * importing / listing this file NEVER creates a DB client and NEVER
//     throws (no getE2eAdminClient() at module scope);
//   * the fail-closed guard is checked in a lifecycle hook — when mutation
//     is not opted in (or the target is not an approved local/test DB) the
//     mutating tests SKIP with a clear reason instead of failing collection;
//   * the client itself is created lazily, only inside a test body that
//     actually mutates, via getE2eAdminClient() (which still re-validates
//     fail-closed on every call).
// ---------------------------------------------------------------------------
let adminClient: ReturnType<typeof getE2eAdminClient> | null = null;

function db(): ReturnType<typeof getE2eAdminClient> {
  if (!adminClient) adminClient = getE2eAdminClient();
  return adminClient;
}

test.beforeEach(async ({ page }) => {
  const status = e2eDbMutationStatus();
  const target = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54331";
  test.skip(
    !status.allowed,
    `[e2e-db-guard] DB mutations unavailable: ${status.reason} (target: ${target})`
  );
  // these specs also sign in through the email-login flow — skip cleanly
  // when email auth is intentionally unavailable on the app under test
  await requireEmailAuth(page);
});

test.describe("desktop home major column", () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test("a student with a major shows the major NAME in the desktop table", async ({ page }) => {
    const admin = db(); // lazy fail-closed client — only after hook skips passed
    const studentId = "44444444-4444-4444-4444-4444444444f1";
    const majorId = "d3333333-3333-3333-3333-3333333333f1";
    // seed: student (broad viewer sees all non-archived) + major + project-less fallback
    await admin.from("students").delete().eq("id", studentId);
    await admin.from("majors").upsert({ id: majorId, name: "קולנוע בדיקות" });
    const { data: group } = await admin.from("greenhouse_groups").select("id").limit(1);
    const ins = await admin.from("students").insert({
      id: studentId,
      first_name: "מגמה",
      last_name: "בדיקה־דסקטופ",
      major_id: majorId,
      group_id: group?.[0]?.id ?? null,
      is_archived: false,
    });
    if (ins.error) throw new Error("student seed failed: " + ins.error.message);

    try {
      await login(page, USERS.admin); // super_admin → broad viewer → "כל החניכים" table
      await expect(page.getByText("כל החניכים")).toBeVisible();
      const row = page.getByRole("row").filter({ hasText: "מגמה בדיקה־דסקטופ" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("קולנוע בדיקות"); // the major NAME is visible
      await logout(page);
    } finally {
      await admin.from("students").delete().eq("id", studentId);
      await admin.from("majors").delete().eq("id", majorId);
    }
  });
});

test.describe("project intake admin route", () => {
  test("קבלת פרויקטים opens the intake page — no crash — and renders rows", async ({ page }) => {
    const admin = db(); // lazy fail-closed client — only after hook skips passed
    const windowId = "eeeeeeee-4444-4444-4444-444444444441";
    await admin.from("intake_windows").delete().eq("id", windowId);
    const { data: staff } = await admin.from("profiles").select("id").eq("is_active", true).limit(1);
    const win = await admin.from("intake_windows").insert({
      id: windowId,
      title: "בדיקת מסך קבלה",
      token_hash: "e".repeat(64),
      opens_at: new Date(Date.now() - 3600e3).toISOString(),
      closes_at: new Date(Date.now() + 86400e3).toISOString(),
      is_revoked: false,
      created_by_staff_id: staff![0]!.id,
    });
    if (win.error) throw new Error("window seed failed: " + win.error.message);

    try {
      await login(page, USERS.admin);
      // navigate via links — dev-mode page.goto to a cold route can abort
      await page.getByRole("link", { name: "ניהול" }).click();
      await page.getByRole("link", { name: "קבלת פרויקטים" }).click();
      await expect(page.getByText("טפסי קבלה ציבוריים")).toBeVisible();
      // the seeded intake row renders with its actions (title also appears
      // in the CSV dropdown → scope to the row list item)
      const row = page.getByRole("listitem").filter({ hasText: "בדיקת מסך קבלה" });
      await expect(row).toBeVisible();
      await expect(row.getByRole("button", { name: "מחיקה" })).toBeVisible();
      await expect(row.getByRole("button", { name: "יצירת קישור נוסף" })).toBeVisible();
      // no error boundary
      await expect(page.getByText("משהו השתבש")).toHaveCount(0);
      await logout(page);
    } finally {
      await admin.from("intake_windows").delete().eq("id", windowId);
    }
  });
});

// ============================================================================
// "העתקת קישור" / "יצירת קישור נוסף" — clipboard must receive a COMPLETE
// ABSOLUTE public intake URL (never the bare token), identical on every
// copy, with zero DB/token rotation.
// ============================================================================

import { createCipheriv, createHash, randomBytes } from "node:crypto";

test.describe("intake link copy", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  // mirrors src/lib/intake-crypto.ts (AES-256-GCM, hex) with the LOCAL test key
  function encryptForTest(plaintext: string) {
    const keyHex =
      process.env.INTAKE_TOKEN_ENCRYPTION_KEY ??
      "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      encrypted_token: enc.toString("hex"),
      encryption_iv: iv.toString("hex"),
      encryption_tag: cipher.getAuthTag().toString("hex"),
    };
  }

  async function openIntakePage(page: import("@playwright/test").Page) {
    await login(page, USERS.admin);
    await page.getByRole("link", { name: "ניהול" }).click();
    await page.getByRole("link", { name: "קבלת פרויקטים" }).click();
    await expect(page.getByText("טפסי קבלה ציבוריים")).toBeVisible();
  }

  test("העתקת קישור copies the complete absolute URL, identically, without rotating", async ({ page }) => {
    const admin = db(); // lazy fail-closed client — only after hook skips passed
    const W = "eeeeeeee-5555-5555-5555-555555555551";
    await admin.from("intake_windows").delete().eq("id", W);
    const { data: staff } = await admin.from("profiles").select("id").eq("is_active", true).limit(1);
    await admin.from("intake_windows").insert({
      id: W,
      title: "בדיקת העתקת קישור",
      token_hash: "5".repeat(64),
      opens_at: new Date(Date.now() - 3600e3).toISOString(),
      closes_at: new Date(Date.now() + 86400e3).toISOString(),
      is_revoked: false,
      created_by_staff_id: staff![0]!.id,
      ...encryptForTest("abc123-e2e-token"),
    });
    const { data: before } = await admin
      .from("intake_windows")
      .select("token_hash, updated_at, encrypted_token")
      .eq("id", W)
      .maybeSingle();

    try {
      await page.goto("/");
      await openIntakePage(page);
      const row = page.getByRole("listitem").filter({ hasText: "בדיקת העתקת קישור" });
      const copyBtn = row.getByRole("button", { name: "העתקת קישור" });
      await copyBtn.click();
      await expect(row.getByText("הועתק ✓")).toBeVisible();

      const copied1 = await page.evaluate(() => navigator.clipboard.readText());
      // 1. absolute URL on the CURRENT origin
      expect(copied1.startsWith("http://localhost:3222/")).toBe(true);
      // 2. correct public intake route + token
      expect(copied1).toContain("/intake/abc123-e2e-token");
      // 3. NOT just the token
      expect(copied1).not.toBe("abc123-e2e-token");
      expect(copied1).toBe("http://localhost:3222/intake/abc123-e2e-token");

      // 4. repeated Copy Link → exactly the same complete URL
      await copyBtn.click();
      await expect(row.getByText("הועתק ✓")).toBeVisible();
      const copied2 = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied2).toBe(copied1);

      // 6. no DB/token rotation
      const { data: after } = await admin
        .from("intake_windows")
        .select("token_hash, updated_at, encrypted_token")
        .eq("id", W)
        .maybeSingle();
      expect(after?.token_hash).toBe(before?.token_hash);
      expect(after?.updated_at).toBe(before?.updated_at);
      expect(after?.encrypted_token).toBe(before?.encrypted_token);
      const { count } = await admin
        .from("intake_window_tokens")
        .select("id", { count: "exact", head: true })
        .eq("intake_window_id", W);
      expect(count).toBe(0);
      await logout(page);
    } finally {
      await admin.from("intake_windows").delete().eq("id", W);
    }
  });

  test("יצירת קישור נוסף and later העתקת קישור yield the same absolute URL; legacy link intact", async ({ page }) => {
    const admin = db(); // lazy fail-closed client — only after hook skips passed
    const W = "eeeeeeee-6666-6666-6666-666666666661";
    const legacyHash = createHash("sha256").update("legacy-e2e-token").digest("hex");
    await admin.from("intake_windows").delete().eq("id", W);
    const { data: staff } = await admin.from("profiles").select("id").eq("is_active", true).limit(1);
    await admin.from("intake_windows").insert({
      id: W,
      title: "בדיקת קישור נוסף",
      token_hash: legacyHash,
      opens_at: new Date(Date.now() - 3600e3).toISOString(),
      closes_at: new Date(Date.now() + 86400e3).toISOString(),
      is_revoked: false,
      created_by_staff_id: staff![0]!.id,
    });

    try {
      await page.goto("/");
      await openIntakePage(page);
      const row = page.getByRole("listitem").filter({ hasText: "בדיקת קישור נוסף" });

      // A. generate an additional link → modal shows/copies the absolute URL
      await row.getByRole("button", { name: "יצירת קישור נוסף" }).click();
      const modal = page.locator('div[role="dialog"][aria-label="הקישור הציבורי"]');
      await expect(modal).toBeVisible();
      const shown = await modal.innerText();
      expect(shown).toContain("/intake/");
      await modal.getByRole("button", { name: "העתקה" }).click();
      const copiedA = await page.evaluate(() => navigator.clipboard.readText());
      expect(copiedA.startsWith("http://localhost:3222/")).toBe(true);
      expect(copiedA).toContain("/intake/");
      const newToken = copiedA.split("/intake/")[1];
      expect(newToken!.length).toBeGreaterThan(20);
      await modal.getByRole("button", { name: "סגירה" }).click();

      // B. later "העתקת קישור" → the SAME complete absolute URL
      await row.getByRole("button", { name: "העתקת קישור" }).click();
      await expect(row.getByText("הועתק ✓")).toBeVisible();
      const copiedB = await page.evaluate(() => navigator.clipboard.readText());
      expect(copiedB).toBe(copiedA);

      // legacy token untouched → old link still valid
      const { data: after } = await admin
        .from("intake_windows")
        .select("token_hash")
        .eq("id", W)
        .maybeSingle();
      expect(after?.token_hash).toBe(legacyHash);
      const { count } = await admin
        .from("intake_window_tokens")
        .select("id", { count: "exact", head: true })
        .eq("intake_window_id", W);
      expect(count).toBe(1);
      await logout(page);
    } finally {
      await admin.from("intake_windows").delete().eq("id", W);
    }
  });
});
