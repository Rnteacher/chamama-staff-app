import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

/**
 * Phase 3: student employment management.
 *
 * The seeded stack provides:
 *   - איתי גפן = employment_coordinator (itay@chamama.example)
 *   - נועם אבידן (ג): active placement בית קפה החממה, Tue 08:30–15:00, 690min
 *   - ליאו הלוי (ב): exactly 200h   |   אופק טל (ד): 204h (above)
 *   - אורי חדד (ג): eligible without placement
 *   - תום בר = plain staff (read-only)
 */

async function loginAndGoTo(
  page: Page,
  user: { email: string; password: string },
  path: string
) {
  await login(page, user);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto(path);
}

test.describe("employment management (desktop)", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "desktop-only view");

  test("admin table renders with progress columns and filters", async ({ page }) => {
    await loginAndGoTo(page, USERS.admin, "/admin/employment");

    await expect(page.getByRole("heading", { name: "ניהול תעסוקה" })).toBeVisible();
    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    // seeded rows: partial (690min = 11.5h) / exactly 200 / above (204h)
    await expect(page.getByText("11.5 שעות / 200 שעות").first()).toBeVisible();
    await expect(page.getByText("200 שעות / 200 שעות").first()).toBeVisible();
    await expect(page.getByText("204 שעות / 200 שעות").first()).toBeVisible();

    // >200h: the numeric label may exceed 200 but the bar must NOT overflow
    const aboveRow = page.locator("tr", { hasText: "אופק טל" }).first();
    await expect(aboveRow.getByText("204 שעות / 200 שעות")).toBeVisible();
    await expect(
      aboveRow.locator('span[style*="width"]').last()
    ).toHaveAttribute("style", /width:\s*100(\.0)?%/);

    // missing year is SURFACED, not hidden (תהל מוסקל is seeded without a year)
    await expect(page.getByText("שנה לא הוגדרה").first()).toBeVisible();

    // "year not set" filter isolates exactly those students
    await page.getByLabel("שכבה").selectOption("0");
    await expect(page.getByText("תהל מוסקל").first()).toBeVisible();
    await expect(page.getByText("נועם אבידן").first()).toBeHidden();

    // back to all
    await page.getByLabel("שכבה").selectOption({ label: "הכל" });

    // leadership/super_admin sets the missing year inline → student becomes
    // employment-relevant with a real year (badge disappears after refresh;
    // the transient success message may unmount with its row, so assert the
    // actual outcome)
    await page.locator("#year-44444444-4444-4444-4444-44444444440e").selectOption("2");
    await page.getByRole("button", { name: "שמירת שנה" }).click();
    await expect(page.getByText("שנה לא הוגדרה").first()).toBeHidden({ timeout: 15_000 });

    // status filter: only placement-less students remain
    await page.getByLabel("שיבוץ").selectOption({ label: "ללא שיבוץ" });
    await expect(page.getByText("מאיה דרורי").first()).toBeVisible();
    await expect(page.getByText("נועם אבידן").first()).toBeHidden();

    // cleanup: restore the seed state (year cleared via admin students)
    await page.goto("/admin/students");
    const article = page.locator("article", { hasText: "תהל מוסקל" }).first();
    await article.getByText("עריכה").click();
    await article.getByLabel("שכבה").selectOption({ label: "— ללא —" });
    await article.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByText("הפעולה בוצעה").first()).toBeVisible();

    await page.goto("/admin/employment");
    await expect(page.getByText("שנה לא הוגדרה").first()).toBeVisible();
  });

  test("coordinator creates a placement with weekly slots; student page reflects it", async ({
    page,
  }) => {
    await loginAndGoTo(page, USERS.coordinator, "/admin/employment/44444444-4444-4444-4444-444444444402");

    await page.getByLabel("מקום עבודה").fill("חממת הבדיקות");
    await page.getByRole("button", { name: "יצירת שיבוץ" }).click();
    await expect(page.getByText("הפעולה בוצעה")).toBeVisible();

    // student page shows the employment summary
    await page.goto("/students/44444444-4444-4444-4444-444444444402");
    await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
    await expect(page.getByText("חממת הבדיקות")).toBeVisible();
    await expect(page.getByText("יום שלישי 08:30–15:00")).toBeVisible();
  });

  test("plain staff sees the read-only summary without manage controls", async ({ page }) => {
    await loginAndGoTo(page, USERS.staff, "/students/44444444-4444-4444-4444-444444444401");
    await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
    await expect(page.getByText("בית קפה החממה")).toBeVisible();
    // no edit link for ordinary staff
    await expect(page.getByRole("link", { name: "ניהול תעסוקה ›" })).toBeHidden();
    await logout(page);
  });

  test("View-As blocks employment mutations", async ({ page }) => {
    await login(page, USERS.admin);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    await page.goto("/admin");
    await page.getByLabel(/צפה כ־/).selectOption({ label: "תום בר" });
    await page.getByLabel("בתפקיד").selectOption({ label: "איש/אשת צוות" });
    await page.getByRole("button", { name: "הפעלה" }).click();
    await expect(page.getByText("מצב צפייה כ־")).toBeVisible();

    // View-As as plain staff → management screens render read-only:
    // no mutation controls anywhere
    await page.goto("/admin/employment/44444444-4444-4444-4444-444444444401");
    await expect(page.getByText("שיבוץ לעבודה (צפייה בלבד)")).toBeVisible();
    await expect(page.getByRole("button", { name: "שמירת שינויים" })).toBeHidden();
    await expect(page.getByRole("button", { name: "סיום שיבוץ" })).toBeHidden();
    await expect(page.getByRole("button", { name: "רישום שעות" })).toBeHidden();
    await logout(page);
  });
});

test.describe("employment (mobile)", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 1024, "mobile-only view");

  test("coordinator records hours: student → date → start/end → save", async ({ page }) => {
    await loginAndGoTo(page, USERS.coordinator, "/admin/employment/44444444-4444-4444-4444-444444444401");

    // compact hour-entry form (exact labels — slot repeaters use "שעת התחלה N")
    await page.getByLabel("שעת התחלה", { exact: true }).fill("09:00");
    await page.getByLabel("שעת סיום", { exact: true }).fill("13:00");
    await expect(page.getByText(/משך מחושב: 4 שעות/)).toBeVisible();
    await page.getByRole("button", { name: "רישום שעות" }).click();
    await expect(page.getByText("השעות נרשמו")).toBeVisible();

    // total recomputed: 690 + 240 = 930 min = 15.5h
    await expect(page.getByText("15.5 שעות / 200 שעות").first()).toBeVisible();

    // cleanup the created log (keep runs idempotent on shared dev data)
    await page.getByRole("button", { name: "מחיקה" }).first().click();
    await expect(page.getByText("11.5 שעות / 200 שעות").first()).toBeVisible();

    // mobile student page summary stays compact
    await page.goto("/students/44444444-4444-4444-4444-444444444401");
    await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
  });
});

test.describe("meeting conflict includes employment", () => {
  test("scheduling a meeting during a planned work day warns", async ({ page }) => {
    await loginAndGoTo(page, USERS.mentor, "/");
    await page.goto("/search");
    await page.getByLabel("חיפוש חניך לפי שם").fill("נוע");
    await page.getByText("נועם אבידן").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "הוספת פגישה" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("שעה").fill("10:00");
    await dialog.getByLabel("יום בשבוע").selectOption({ label: "שלישי" });

    // employment conflict surfaced with the workplace name
    await expect(
      dialog.getByText(/בעבודה בבית קפה החממה/)
    ).toBeVisible({ timeout: 15_000 });

    // explicit override still allowed
    await dialog.getByText("קביעה בכל זאת").click();
    await expect(dialog.getByRole("button", { name: "שמירה" })).toBeEnabled();
  });
});
