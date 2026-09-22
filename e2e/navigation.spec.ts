import { test, expect } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

test.describe("navigation", () => {
  test("home → groups → group → student within a few taps", async ({ page }) => {
    await login(page, USERS.staff);

    // bottom nav: קבוצות
    await page.getByRole("navigation", { name: "ניווט ראשי" }).getByText("קבוצות").click();
    await expect(page.getByRole("heading", { name: "קבוצות", exact: true })).toBeVisible();

    // open a seeded group (wait for the navigation to land on the group page —
    // the mentor line exists on BOTH the list cards and the group page)
    await page.getByRole("link", { name: /קבוצת זית/ }).first().click();
    await page.waitForURL(/\/groups\/[0-9a-f-]{36}$/, { timeout: 10_000 });
    await expect(page.getByText("מנטורים: מיכל שרון")).toBeVisible();

    // open a seeded student
    await page.getByText("נועם אבידן").click();
    await expect(page.getByRole("heading", { name: "נועם אבידן" })).toBeVisible();
    await expect(page.getByText("מנטורים:")).toBeVisible();
    await expect(page.getByRole("button", { name: "שליחת עדכון" })).toBeVisible();
  });

  test("bottom nav: Search and More are gone; Settings replaces More", async ({
    page,
  }) => {
    await login(page, USERS.staff);
    const nav = page.getByRole("navigation", { name: "ניווט ראשי" });
    await expect(nav.getByText("חיפוש")).toHaveCount(0);
    await expect(nav.getByText("עוד")).toHaveCount(0);
    await expect(nav.getByText("הגדרות")).toBeVisible();
    await expect(nav.getByText("עדכונים")).toBeVisible();
    await expect(nav.getByText("בית")).toBeVisible();
  });

  test("student search lives on Home (no dedicated nav destination)", async ({
    page,
  }) => {
    await login(page, USERS.staff);
    await page.getByRole("link", { name: "חיפוש חניך…" }).click();
    await page.getByLabel("חיפוש חניך לפי שם").fill("נוע");
    await expect(page.getByText("נועם אבידן")).toBeVisible();
    await page.getByLabel("חיפוש חניך לפי שם").fill("זזזלאנמצא");
    await expect(page.getByText("לא נמצאו חניכים")).toBeVisible();
  });
});
