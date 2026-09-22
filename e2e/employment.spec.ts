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

  test("admin table renders with progress columns, cohort eligibility and filters", async ({ page }) => {
    await loginAndGoTo(page, USERS.admin, "/admin/employment");

    await expect(page.getByRole("heading", { name: "ניהול תעסוקה" })).toBeVisible();
    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    // seeded rows: partial (690min = 11.5h, זית) / exactly-200 (שקד) / above (204h, רימון)
    await expect(page.getByText("11.5 שעות / 200 שעות").first()).toBeVisible();
    await expect(page.getByText("204 שעות / 200 שעות").first()).toBeVisible();

    // >200h: the numeric label may exceed 200 but the bar must NOT overflow
    const aboveRow = page.locator("tr", { hasText: "אופק טל" }).first();
    await expect(aboveRow.getByText("204 שעות / 200 שעות")).toBeVisible();
    await expect(
      aboveRow.locator('span[style*="width"]').last()
    ).toHaveAttribute("style", /width:\s*100(\.0)?%/);

    // eligibility is operational logic, not a column: only EFFECTIVELY-eligible
    // students are listed (seeded cohorts זית=ז(7) שקד=ש(21) רימון=ר(20) דקל=ד(4)
    // → שקד is the youngest and never reaches this screen)
    await expect(page.getByRole("columnheader", { name: "זכאות" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "קבוצה", exact: true })).toBeVisible();
    await expect(page.getByText("ליאו הלוי")).toHaveCount(0);
    await expect(page.getByText("לא · שנתון צעיר")).toHaveCount(0);
    await expect(page.getByText("שנה לא הוגדרה")).toHaveCount(0);
    await expect(page.getByLabel("שכבה")).toHaveCount(0);

    // status filter: only placement-less students remain
    await page.getByLabel("שיבוץ").selectOption({ label: "ללא שיבוץ" });
    await expect(page.getByText("מאיה דרורי").first()).toBeVisible();
    await expect(page.getByText("נועם אבידן").first()).toBeHidden();
  });

  test("coordinator creates a placement with weekly slots; student page reflects it", async ({
    page,
  }) => {
    await loginAndGoTo(page, USERS.coordinator, "/admin/employment/44444444-4444-4444-4444-444444444402");

    // idempotent across suite runs: a placement from a previous run puts the
    // editor in edit mode with the same workplace already saved
    const create = page.getByRole("button", { name: "יצירת שיבוץ" });
    if (await create.isVisible().catch(() => false)) {
      await page.getByLabel("מקום עבודה").fill("חממת הבדיקות");
      await create.click();
      await expect(page.getByText("הפעולה בוצעה")).toBeVisible();
    } else {
      await expect(page.getByText("עריכת שיבוץ לעבודה")).toBeVisible();
    }

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

  test("View-As as plain staff: management hidden and mutations blocked", async ({ page }) => {
    await login(page, USERS.admin);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    await page.goto("/admin");
    await page.getByLabel(/צפה כ־/).selectOption({ label: "תום בר" });
    await page.getByLabel("בתפקיד").selectOption({ label: "איש/אשת צוות" });
    await page.getByRole("button", { name: "הפעלה" }).click();
    await expect(page.getByText("מצב צפייה כ־")).toBeVisible();

    // a simulated ordinary staff member gets the ordinary read experience:
    // no ניהול entry anywhere, and management routes are denied outright
    await expect(page.getByRole("link", { name: "ניהול" })).toHaveCount(0);
    await page.goto("/admin/employment/44444444-4444-4444-4444-444444444401");
    await page.waitForURL((u) => !u.pathname.startsWith("/admin"));
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
