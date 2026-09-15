import { test, expect } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

test.describe("navigation", () => {
  test("home → groups → group → student within a few taps", async ({ page }) => {
    await login(page, USERS.staff);

    // bottom nav: קבוצות
    await page.getByRole("navigation", { name: "ניווט ראשי" }).getByText("קבוצות").click();
    await expect(page.getByRole("heading", { name: "קבוצות החממה" })).toBeVisible();

    // open a seeded group
    await page.getByText("קבוצת זית").click();
    await expect(page.getByText("מנטורים: מיכל שרון")).toBeVisible();

    // open a seeded student
    await page.getByText("נועם אבידן").click();
    await expect(page.getByRole("heading", { name: "נועם אבידן" })).toBeVisible();
    await expect(page.getByText("מנטורים:")).toBeVisible();
    await expect(page.getByRole("button", { name: "שליחת עדכון" })).toBeVisible();
  });

  test("student search by partial Hebrew name", async ({ page }) => {
    await login(page, USERS.staff);
    await page.getByRole("navigation", { name: "ניווט ראשי" }).getByText("חיפוש").click();
    await page.getByLabel("חיפוש חניך לפי שם").fill("נוע");
    await expect(page.getByText("נועם אבידן")).toBeVisible();
    await page.getByLabel("חיפוש חניך לפי שם").fill("זזזלאנמצא");
    await expect(page.getByText("לא נמצאו חניכים")).toBeVisible();
  });
});
