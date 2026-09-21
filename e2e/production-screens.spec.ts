import { test, expect } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";
import { getE2eAdminClient } from "./test-db-guard";

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

// throws at load time unless the target is local/test AND the opt-in is set
const admin = getE2eAdminClient();

test.describe("desktop home major column", () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test("a student with a major shows the major NAME in the desktop table", async ({ page }) => {
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
