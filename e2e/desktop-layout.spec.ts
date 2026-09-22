import { test, expect } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

/**
 * Structural desktop-layout checks (layout pass only).
 * Runs in the desktop-chromium project (1440×900); the mobile project
 * inherits the app's unchanged mobile layout.
 */

test.describe("desktop layout", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "desktop-only view");

  test("home: shell uses desktop width; ordinary staff get search, not a role table", async ({
    page,
  }) => {
    await login(page, USERS.staff);

    const main = page.locator("main");
    const width = (await main.boundingBox())?.width ?? 0;
    expect(width).toBeGreaterThan(1200);

    // the global student-search entry is visible on desktop too
    await expect(page.getByRole("link", { name: "חיפוש חניך…" })).toBeVisible();

    // ordinary staff (no mentor/master relationship) get NO role-based table
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("home: mentor sees a relationship-scoped table on desktop", async ({ page }) => {
    await login(page, USERS.mentor);
    await expect(page.getByRole("table").first()).toBeVisible();
    await expect(page.getByText("החניכים שלי", { exact: true })).toBeVisible();
  });

  test("home: canvas is capped at 1600px on very wide screens", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await login(page, USERS.staff);
    const width = (await page.locator("main").boundingBox())?.width ?? 0;
    expect(width).toBeGreaterThan(1500);
    expect(width).toBeLessThanOrEqual(1600);
  });

  test("student page: feed column and meetings/summary column sit side-by-side", async ({ page }) => {
    await login(page, USERS.staff);
    await page.goto("/search");
    await page.getByLabel("חיפוש חניך לפי שם").fill("נוע");
    await page.getByText("נועם אבידן").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const viewportWidth = page.viewportSize()?.width ?? 1440;
    const meetings = await page
      .getByRole("heading", { name: "פגישה שבועית" })
      .boundingBox();
    // RTL: the secondary column (meetings) sits on the LEFT half of the canvas
    expect(meetings).toBeTruthy();
    expect(meetings!.x + meetings!.width / 2).toBeLessThan(viewportWidth / 2);
  });
});
