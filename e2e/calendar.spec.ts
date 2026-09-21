import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

/**
 * Phase 2: annual calendar + unified daily schedule + conflict warnings.
 *
 * The seeded stack provides:
 *   - 10 calendar events (one-off / all-day / multi-day / weekly / monthly /
 *     cancelled) with all audience types
 *   - weekly mentor meeting for נועם with מיכל on Mondays 16:00
 *   - קבוצת צילום slot Monday 16:00–17:30 (conflict scenario)
 *   - staff leader מיכל (mentor of זית)
 */

/**
 * login() returns as soon as the login page's own heading is visible — the
 * post-login redirect may still be in flight. Wait for it to complete.
 */
async function loginAndWait(page: Page, user: { email: string; password: string }) {
  await login(page, user);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

async function loginAndGoTo(
  page: Page,
  user: { email: string; password: string },
  path: string
) {
  await loginAndWait(page, user);
  await page.goto(path);
}

/** Jerusalem "today" as YYYY-MM-DD (mirrors the server-side helper). */
function jerusalemTodayISO(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

test.describe("desktop annual calendar", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "desktop-only view");

  test("renders the 12-month school-year overview with events", async ({ page }) => {
    await loginAndGoTo(page, USERS.staff, "/calendar");

    // 12 month mini-grids
    await expect(page.locator("section[aria-label^='ספטמבר']")).toBeVisible();
    await expect(page.locator("section[aria-label^='אוגוסט']")).toHaveCount(1);
    const monthCards = page.locator("section[aria-label^='מרץ'], section[aria-label^='דצמבר']");
    await expect(monthCards.first()).toBeVisible();

    // today is highlighted and current
    await expect(page.locator(`[aria-current="date"]`)).toBeVisible();

    // seeded event appears on its day detail (today: יום ספורט 09:00–13:00)
    await page.locator("section[aria-label='פירוט יום']").getByText("יום ספורט").click();
    // read-only viewer: no editor form, details dialog instead
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "סגירה" }).click();
  });

  test("clicking a date zooms into that day", async ({ page }) => {
    await loginAndGoTo(page, USERS.staff, "/calendar");
    const today = jerusalemTodayISO();
    const tomorrow = addDaysISO(today, 1);
    // click tomorrow's cell in any month card
    await page.locator(`button[data-date="${tomorrow}"]`).first().click();
    await expect(page.getByRole("region", { name: "פירוט יום" })).toContainText("יום צילומים");
    await expect(page.getByRole("region", { name: "פירוט יום" })).toContainText("כל היום");
  });

  test("leadership creates an event; it appears in the year view; then deletes it", async ({
    page,
  }) => {
    await loginAndGoTo(page, USERS.admin, "/calendar");
    await page.getByRole("button", { name: "הוספת אירוע" }).first().click();
    const dialog = page.getByRole("dialog");

    const title = `בדיקת אירוע ${Date.now()}`;
    await dialog.getByLabel("כותרת").fill(title);
    // start date prefilled with the selected day; weekly recurrence with until
    await dialog.getByText("שבועי", { exact: true }).click();
    await dialog.getByLabel("חוזר עד (תאריך כולל)").fill(addDaysISO(jerusalemTodayISO(), 60));
    // audience: כולם
    await dialog.getByRole("checkbox", { name: "כולם" }).check();
    await dialog.getByRole("button", { name: "יצירת אירוע" }).click();
    await expect(dialog.getByText("הפעולה בוצעה")).toBeHidden(); // dialog closes on refresh
    await page.waitForTimeout(1000);

    // the event's title appears somewhere in the day detail (selected day)
    await expect(
      page.locator("section[aria-label='פירוט יום']").getByText(title)
    ).toBeVisible();

    // edit: open it, rename
    await page.locator("section[aria-label='פירוט יום']").getByText(title).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("כותרת").fill(`${title} מעודכן`);
    await editDialog.getByRole("button", { name: "שמירת שינויים" }).click();
    await page.waitForTimeout(1000);
    await expect(
      page.locator("section[aria-label='פירוט יום']").getByText(`${title} מעודכן`)
    ).toBeVisible();

    // delete
    await page.locator("section[aria-label='פירוט יום']").getByText(`${title} מעודכן`).click();
    const delDialog = page.getByRole("dialog");
    await delDialog.getByRole("button", { name: "מחיקת האירוע" }).click();
    await delDialog.getByRole("button", { name: "אישור מחיקה" }).click();
    await page.waitForTimeout(1000);
    await expect(
      page.locator("section[aria-label='פירוט יום']").getByText(`${title} מעודכן`)
    ).toBeHidden();
  });

  test("validation: recurring event without until is blocked client-side", async ({
    page,
  }) => {
    await loginAndGoTo(page, USERS.admin, "/calendar");
    await page.getByRole("button", { name: "הוספת אירוע" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("כותרת").fill("חוזר בלי סוף");
    await dialog.getByText("שבועי", { exact: true }).click();
    // no until date → HTML required blocks submission; the until input is mandatory
    await expect(dialog.getByLabel("חוזר עד (תאריך כולל)")).toHaveAttribute("required", "");
  });

  test("View-As hides mutation controls", async ({ page }) => {
    await loginAndWait(page, USERS.admin);
    await page.goto("/admin");
    await page.getByLabel(/צפה כ־/).selectOption({ label: "תום בר" });
    await page.getByLabel("בתפקיד").selectOption({ label: "איש/אשת צוות" });
    await page.getByRole("button", { name: "הפעלה" }).click();
    await expect(page.getByText("מצב צפייה כ־")).toBeVisible();

    await page.goto("/calendar");
    await expect(page.getByRole("button", { name: "הוספת אירוע" })).toBeHidden();
    await page.getByRole("button", { name: /יום ספורט/ }).first().click();
    // read-only dialog: no save/delete buttons
    await expect(page.getByRole("button", { name: "שמירת שינויים" })).toBeHidden();
    await expect(page.getByRole("button", { name: "מחיקת האירוע" })).toBeHidden();
    await logout(page);
  });
});

test.describe("mobile calendar + home", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 1024, "mobile-only view");

  test("mobile shows compact agenda instead of the 12-month grid", async ({ page }) => {
    await loginAndGoTo(page, USERS.staff, "/calendar");
    // year grid hidden on mobile; agenda visible
    await expect(page.locator("section[aria-label='אירועים קרובים']")).toBeVisible();
    await expect(page.getByText("יום ספורט").first()).toBeVisible();
    // the 12-month grid is desktop-only
    const yearGrid = page.locator("div.hidden.lg\\:grid").first();
    await expect(yearGrid).toBeHidden();
  });

  test("mobile home shows היום שלי and קבוצות למידה היום", async ({ page }) => {
    await loginAndGoTo(page, USERS.mentor, "/");
    await expect(page.getByRole("heading", { name: "היום שלי" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "קבוצות למידה היום" })).toBeVisible();

    // מיכל leads קבוצת צילום; on Mondays the schedule shows it
    const dow = new Date().getDay(); // JS weekday; the server seeds make this deterministic on Mondays
    test.info().annotations.push({ type: "note", description: `weekday: ${dow}` });

    // all-day badge appears when an all-day event applies (יום צילומים is everyone)
    // learning groups list is chronological and deep-links to the group page
    const lgToday = page.locator("section[aria-labelledby='lg-today-heading']");
    await expect(lgToday).toBeVisible();
  });
});

test.describe("meeting conflict warnings", () => {
  test("weekly meeting overlapping a learning-group slot warns and can be overridden", async ({
    page,
  }) => {
    await loginAndGoTo(page, USERS.mentor, "/");
    // open נועם (mentor of זית)
    await page.goto("/search");
    await page.getByLabel("חיפוש חניך לפי שם").fill("נוע");
    await page.getByText("נועם אבידן").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // open the weekly-meeting dialog (conflict: קבוצת צילום Mon 16:00–17:30)
    await page.getByRole("button", { name: "הוספת פגישה" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("שעה").fill("16:00");
    // ensure Monday is selected (default weekday 0 — pick שני)
    await dialog.getByLabel("יום בשבוע").selectOption({ label: "שני" });

    // server-backed warning appears
    await expect(dialog.getByText("נמצאו חפיפות בלוח הזמנים של החניך/ה:")).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByText(/קבוצת הלמידה "קבוצת צילום"/).first()).toBeVisible();
    // save is blocked until the explicit override
    await expect(dialog.getByRole("button", { name: "שמירה" })).toBeDisabled();

    // override succeeds
    await dialog.getByText("קביעה בכל זאת").click();
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
  });
});
