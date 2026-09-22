import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

/**
 * Calendar permissions + CSV import (operational UX correction pass).
 *
 *  - the full calendar management screen is leadership/super_admin ONLY
 *    (server-side route guard; ordinary staff get access-denied on direct URL)
 *  - ordinary staff keep event visibility in היום שלי (personal schedule)
 *  - CSV import: preview + per-row validation + explicit confirm
 */

async function loginAndGoTo(page: Page, user: { email: string; password: string }, path: string) {
  await login(page, user);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto(path);
}

/** Hebrew UTF-8 CSV (no BOM — the server strips one if present). */
function csvFile(rows: string[]): Buffer {
  return Buffer.from(rows.join("\r\n"), "utf8");
}

const VALID_CSV = [
  "כותרת,תאריך התחלה,שעת התחלה,תאריך סיום,שעת סיום,כל היום,חזרה,חזרה עד,קהל יעד",
  'ייבוא E2E — מסיבת סיום,2027-06-20,18:00,2027-06-20,21:00,לא,חד פעמי,,כולם',
  'ייבוא E2E — סדנת צוות,2027-06-21,10:00,2027-06-21,12:00,לא,שבועי,2027-07-31,צוות',
].join("\r\n");

const INVALID_CSV = [
  "כותרת,תאריך התחלה,שעת התחלה,תאריך סיום,שעת סיום,כל היום,חזרה,חזרה עד,קהל יעד",
  'ייבוא E2E פגום,לא-תאריך,10:00,2027-06-21,12:00,לא,חד פעמי,,כולם',
].join("\r\n");

test.describe("calendar permissions (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("ordinary staff: no calendar nav, direct /calendar denied, events still in היום שלי", async ({ page }) => {
    await login(page, USERS.staff);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

    // no calendar-management navigation for ordinary staff (neither top bar
    // nor bottom nav — the bottom-nav Calendar item is authorization-gated)
    await expect(
      page.getByRole("navigation", { name: "תפריט עליון" }).getByRole("link", { name: "לוח שנה" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "ניווט ראשי" }).getByRole("link", { name: "לוח שנה" })
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "לוח שנה ›" })).toHaveCount(0);

    // …but the personal day schedule still shows a relevant event WITHOUT a
    // link into the management screen. (Seeded relative dates: יום ספורט /
    // יום צילומים land on today/near-today depending on run time.)
    await expect(page.getByText(/יום (ספורט|צילומים)/)).toBeVisible();

    // direct URL access is denied server-side: the calendar guard redirects
    // to /access-denied, and the proxy then bounces authorized staff off it
    // back to / — /calendar is NEVER rendered for ordinary staff
    await page.goto("/calendar");
    await page.waitForURL((u) => u.pathname !== "/calendar", { timeout: 10_000 });
    await expect(page).not.toHaveURL(/\/calendar/);
    await expect(page.getByText(/שנת הלימודים/)).toHaveCount(0);
  });

  test("leadership can open and manage the calendar", async ({ page }) => {
    await login(page, USERS.admin);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

    await page
      .getByRole("navigation", { name: "ניווט ראשי" })
      .getByRole("link", { name: "לוח שנה" })
      .click();
    await page.waitForURL((u) => u.pathname === "/calendar", { timeout: 10_000 });
    await expect(page.getByText(/שנת הלימודים/).first()).toBeVisible();
  });
});

test.describe("CSV import (desktop, leadership only)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function openCsvPanel(page: Page) {
    await loginAndGoTo(page, USERS.admin, "/calendar");
    await page.getByRole("button", { name: "הורדת קובץ לדוגמה" }).waitFor({ state: "visible" });
    // the template download is offered
    await expect(page.getByRole("button", { name: "הורדת קובץ לדוגמה" })).toBeVisible();
    await page.getByRole("button", { name: "פתיחה" }).click();
  }

  test("preview validates rows; import is explicit and reports success", async ({ page }) => {
    await openCsvPanel(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: "events.csv",
      mimeType: "text/csv",
      buffer: csvFile(VALID_CSV.split("\r\n")),
    });
    await expect(page.getByText("2 שורות תקינות")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("תקינה").first()).toBeVisible();

    // explicit confirm → canonical import (single transaction, audited)
    await page.getByRole("button", { name: "אישור ייבוא" }).click();
    await expect(page.getByText(/יובאו 2 אירועים בהצלחה/)).toBeVisible({ timeout: 15_000 });
  });

  test("a malformed row blocks the import with a row-specific error", async ({ page }) => {
    await openCsvPanel(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: "events-bad.csv",
      mimeType: "text/csv",
      buffer: csvFile(INVALID_CSV.split("\r\n")),
    });
    await expect(page.getByText("0 שורות תקינות")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/תאריך התחלה לא תקין/)).toBeVisible();
    await expect(page.getByText("הייבוא נעול עד שכל השורות תקינות")).toBeVisible();
    await expect(page.getByRole("button", { name: "אישור ייבוא" })).toBeDisabled();
  });

  test("unknown audience target fails the row (never guesses)", async ({ page }) => {
    await openCsvPanel(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: "events-unknown.csv",
      mimeType: "text/csv",
      buffer: csvFile([
        "כותרת,תאריך התחלה,שעת התחלה,תאריך סיום,שעת סיום,כל היום,חזרה,חזרה עד,קהל יעד",
        'ייבוא E2E לא מזוהה,2027-06-20,18:00,2027-06-20,21:00,לא,חד פעמי,,קבוצה:לא קיימת',
      ]),
    });
    await expect(page.getByText(/קהל יעד לא מזוהה/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "אישור ייבוא" })).toBeDisabled();
  });
});
