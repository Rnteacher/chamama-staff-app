import { test, expect } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

test.describe("auth & access", () => {
  test("signed-out user is redirected to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "תיכון החממה" })).toBeVisible();
  });

  test("deactivated allowlisted account lands on access-denied", async ({ page }) => {
    await login(page, USERS.deactivated);
    await expect(
      page.getByRole("heading", { name: "אין הרשאת גישה" })
    ).toBeVisible();
    await expect(page.getByText("דנה אביבי")).toBeVisible();
  });

  test("authorized staff reaches the dashboard", async ({ page }) => {
    await login(page, USERS.staff);
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /שלום/ })).toBeVisible();
  });
});
