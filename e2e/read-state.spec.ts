import { test, expect } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";

/**
 * Read-state persistence — the full production loop, direction-agnostic:
 *   flip read state → RELOAD → flipped state persisted → flip back → RELOAD → original.
 * Also verifies the /updates filters reflect the persisted state.
 */
test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

const MAYA = "מאיה דרורי";
const MARK_READ = "סמן כנקרא";
const MARK_UNREAD = "סמן כלא נקרא";

async function openStudent(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("navigation", { name: "ניווט ראשי" }).getByText("חיפוש").click();
  await page.getByLabel("חיפוש חניך לפי שם").fill(name);
  await page.getByText(name).first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test("mark read/unread persists across reload on the student feed", async ({ page }) => {
  await login(page, USERS.mentor);
  await openStudent(page, MAYA);

  // whichever direction the first item is in, flip it
  const first = page.getByRole("button", { name: /סמן כ(נקרא|לא נקרא)/ }).first();
  await first.waitFor({ state: "visible", timeout: 15000 });
  const before = (await first.textContent())!.trim();
  const after = before === MARK_READ ? MARK_UNREAD : MARK_READ;

  await first.click();
  const flipped = page.getByRole("button", { name: after }).first();
  await expect(flipped).toBeVisible();

  // survives reload
  await page.reload();
  await expect(page.getByRole("button", { name: after }).first()).toBeVisible();

  // flip back and verify the original state persists too
  await page.getByRole("button", { name: after }).first().click();
  await expect(page.getByRole("button", { name: before }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: before }).first()).toBeVisible();
  await logout(page);
});

test("/updates filters reflect persisted read state", async ({ page }) => {
  await login(page, USERS.mentor);
  // navigate via the home link — dev-mode goto to a cold route can abort
  await page.locator('a[href="/updates"]').first().click();
  await page.waitForURL("**/updates");

  await expect(page.getByRole("button", { name: "הכל", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /לא נקראו/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^נקראו/ })).toBeVisible();

  // flip the first item's persisted state
  const first = page.getByRole("button", { name: /סמן כ(נקרא|לא נקרא)/ }).first();
  await first.waitFor({ state: "visible", timeout: 15000 });
  const before = (await first.textContent())!.trim();
  const after = before === MARK_READ ? MARK_UNREAD : MARK_READ;
  await first.click();
  await expect(page.getByRole("button", { name: after }).first()).toBeVisible();

  // reload: persisted; the item is listed under the matching tab.
  // A listed item always offers the OPPOSITE toggle of its current state,
  // so inside the tab the item shows `before` (the reverse of `after`).
  await page.reload();
  await expect(page.getByRole("button", { name: after }).first()).toBeVisible();
  if (after === MARK_UNREAD) {
    await page.getByRole("button", { name: /לא נקראו/ }).click();
  } else {
    await page.getByRole("button", { name: /^נקראו/ }).click();
  }
  await expect(page.getByRole("button", { name: before }).first()).toBeVisible();

  // restore the original state
  await page.getByRole("button", { name: "הכל", exact: true }).click();
  await page.getByRole("button", { name: after }).first().click();
  await expect(page.getByRole("button", { name: before }).first()).toBeVisible();
  await logout(page);
});
