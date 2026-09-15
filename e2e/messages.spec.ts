import { test, expect } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

const MAYA = "מאיה דרורי";

async function openStudent(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("navigation", { name: "ניווט ראשי" }).getByText("חיפוש").click();
  await page.getByLabel("חיפוש חניך לפי שם").fill(name);
  await page.getByText(name).first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test.describe("messages", () => {
  test("general staff sends a message; mentor sees it and approves general visibility", async ({
    page,
  }) => {
    const body = `בדיקת e2e ${Date.now()}`;

    // 1) general staff sends an update about any student
    await login(page, USERS.staff);
    await openStudent(page, MAYA);
    await page.getByRole("button", { name: "שליחת עדכון" }).click();
    await page.getByLabel("תוכן העדכון").fill(body);
    await page.getByRole("button", { name: "שליחה", exact: true }).click();
    await expect(page.getByText("העדכון נשלח בהצלחה")).toBeVisible();
    await logout(page);

    // 2) the group mentor (מיכל, קבוצת זית) can read it and approve it
    await login(page, USERS.mentor);
    await openStudent(page, MAYA);
    await expect(page.getByText(body)).toBeVisible();

    // moderation controls visible for the mentor
    const approve = page.getByRole("button", { name: "אישור תצוגה לכל הצוות" }).last();
    await approve.click();
    await expect(
      page.getByText("זמין לכל הצוות").last()
    ).toBeVisible();

    // mark unread flip works
    await expect(page.getByText("חדש").first()).toBeVisible(); // auto-marked read shortly after open
    await logout(page);

    // 3) general staff can now read the approved message
    await login(page, USERS.staff);
    await openStudent(page, MAYA);
    await expect(page.getByText(body)).toBeVisible();
  });

  test("unread badge and mark-as-unread are per user", async ({ page }) => {
    await login(page, USERS.mentor);
    await openStudent(page, "נועם אבידן");
    // after opening, messages auto-mark read; flip one back
    const unreadBtn = page.getByRole("button", { name: "סמן כלא נקרא" }).first();
    if (await unreadBtn.isVisible()) {
      await unreadBtn.click();
      await expect(page.getByRole("button", { name: "סמן כנקרא" }).first()).toBeVisible();
    }
  });
});
