import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

/**
 * Learning Groups + shared scheduling foundation.
 *
 * Covers: two clearly separated sections on the Groups screen, admin
 * create/edit with multiple slots + multiple leaders, membership management
 * authorization (leader of THAT group vs. unauthorized staff), View-As
 * blocking, the public conflict-aware registration flow, and automatic
 * membership creation.
 *
 * The seeded stack (supabase/seed.sql) provides:
 *   - קבוצת צילום   (Sun 16:00–17:30 + Mon 16:00–17:30) — staff leader מיכל
 *   - קבוצת רובוטיקה (Mon 16:00–17:30) — conflicts with צילום on Monday
 *   - קבוצת מוזיקה  (Wed 10:00–11:00 + 11:00–12:00)
 *   - open registration window with public token: dev-lg-token
 */

const DEV_TOKEN = "dev-lg-token";

/**
 * login() returns as soon as the login page's own heading is visible — the
 * post-login redirect (window.location.assign) may still be in flight, and a
 * page.goto at that moment aborts it before the session cookies land.
 * Wait for the redirect to complete before navigating programmatically.
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

test.describe("groups screen: two sections", () => {
  test("shows קבוצות and קבוצות למידה separately", async ({ page }) => {
    await loginAndGoTo(page, USERS.staff, "/groups");

    await expect(page.getByRole("heading", { name: "קבוצות", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "קבוצות למידה" })).toBeVisible();
    // terminology: the old "קבוצת אם" wording is gone
    await expect(page.getByText(/קבוצת אם|קבוצות אם/)).toHaveCount(0);

    // learning-group card shows slots + member count
    const photoCard = page.getByRole("link", { name: /קבוצת צילום/ }).first();
    await expect(photoCard).toBeVisible();
    await expect(photoCard).toContainText("יום ראשון 16:00–17:30");
    await expect(photoCard).toContainText("יום שני 16:00–17:30");
    await expect(photoCard).toContainText("חניכים");
  });
});

test.describe("admin learning groups", () => {
  test("leadership creates a group with two slots and leaders; it appears on /groups", async ({
    page,
  }) => {
    await loginAndGoTo(page, USERS.admin, "/admin/learning-groups");

    // unique per run: both browser projects run against the same seeded DB
    const groupName = `קבוצת א-סי-אי ${Date.now()}`;

    // scope everything to the CREATE section — every existing group has its
    // own edit form with identical labels
    const createSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "הוספת קבוצת למידה" }) });

    await createSection.getByLabel("שם הקבוצה").fill(groupName);
    // first slot row is prefilled — set values, then add a second row
    const firstRow = createSection
      .locator("fieldset", { hasText: "מפגשים שבועיים" })
      .locator("> div > div")
      .first();
    await firstRow.locator("select[name=slotWeekday]").selectOption({ label: "יום חמישי" });
    await firstRow.locator("input[name=slotStart]").fill("18:00");
    await firstRow.locator("input[name=slotEnd]").fill("19:30");
    await createSection.getByRole("button", { name: "+ הוספת מפגש" }).click();
    const secondRow = createSection
      .locator("fieldset", { hasText: "מפגשים שבועיים" })
      .locator("> div > div")
      .nth(1);
    await secondRow.locator("select[name=slotWeekday]").selectOption({ label: "יום שלישי" });
    await secondRow.locator("input[name=slotStart]").fill("16:00");
    await secondRow.locator("input[name=slotEnd]").fill("17:00");

    // staff leader multi-select
    await createSection.getByRole("checkbox", { name: "מיכל שרון" }).check();

    await createSection.getByRole("button", { name: "הוספה", exact: true }).click();
    await expect(createSection.getByText("הפעולה בוצעה")).toBeVisible();

    // group now appears in the public groups screen with both slots
    await page.goto("/groups");
    const card = page.getByRole("link", { name: new RegExp(groupName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("יום חמישי 18:00–19:30");
    await expect(card).toContainText("יום שלישי 16:00–17:00");
    await expect(card).toContainText("מדריכים: מיכל שרון");
  });

  test("validation: duplicate identical slots → server error", async ({ page }) => {
    await loginAndGoTo(page, USERS.admin, "/admin/learning-groups");
    const createSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "הוספת קבוצת למידה" }) });
    await createSection.getByLabel("שם הקבוצה").fill("קבוצת כפולה");
    // the UI always keeps at least one slot row; add a second IDENTICAL row
    await createSection.getByRole("button", { name: "+ הוספת מפגש" }).click();
    await createSection.getByRole("button", { name: "הוספה", exact: true }).click();
    await expect(
      createSection.getByText("אותו מפגש הוגדר פעמיים")
    ).toBeVisible();
  });
});

test.describe("membership management authorization", () => {
  test("staff leader of THAT group can add and remove a student", async ({ page }) => {
    await loginAndWait(page, USERS.mentor); // מיכל — staff leader of קבוצת צילום
    await page.goto("/groups");
    await page.getByRole("link", { name: /קבוצת צילום/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "קבוצת צילום" })).toBeVisible();

    // add טליה ברקוביץ via the searchable picker
    await page.getByLabel("הוספת חניך/ה לקבוצה").fill("טליה");
    await page.getByRole("button", { name: "הוספה", exact: true }).click();
    const memberRow = page.getByRole("listitem").filter({ hasText: "טליה ברקוביץ" });
    await expect(memberRow).toBeVisible();

    // remove her again — she moves back into the picker list
    await page.getByRole("button", { name: "הסרת טליה ברקוביץ מהקבוצה" }).click();
    await expect(memberRow).toBeHidden();
  });

  test("unauthorized staff sees no management controls", async ({ page }) => {
    await loginAndWait(page, USERS.staff); // תום — plain staff, not a leader
    await page.goto("/groups");
    await page.getByRole("link", { name: /קבוצת צילום/ }).first().click();
    await expect(page.getByText("הוספת חניך/ה לקבוצה")).toBeHidden();
    await expect(page.getByRole("button", { name: /^הסרה$/ })).toBeHidden();
  });
});

test.describe("View-As blocks mutations", () => {
  test("admin in View-As mode gets no membership controls", async ({ page }) => {
    await loginAndWait(page, USERS.admin);
    // View-As entry lives on /admin (ViewAsEntry)
    await page.goto("/admin");
    const entry = page.getByLabel(/צפה כ־/);
    await entry.selectOption({ label: "תום בר" });
    await page.getByLabel("בתפקיד").selectOption({ label: "איש/אשת צוות" });
    await page.getByRole("button", { name: "הפעלה" }).click();
    const banner = page.getByText("מצב צפייה כ־");
    await expect(banner).toBeVisible();

    // the target staff member (תום) is NOT a learning-group leader → no controls
    await page.goto("/groups");
    await page.getByRole("link", { name: /קבוצת צילום/ }).first().click();
    await expect(page.getByText("הוספת חניך/ה לקבוצה")).toBeHidden();
    await expect(page.getByRole("button", { name: /^הסרה$/ })).toBeHidden();

    // exit View-As via the banner
    await page.getByRole("button", { name: "יציאה ממצב צפייה" }).click();
    await expect(banner).toBeHidden();
    await logout(page);
  });
});

test.describe("public registration flow", () => {
  test("loads without login and blocks conflicting groups in the UI", async ({ page }) => {
    await page.goto(`/lg-registration/${DEV_TOKEN}`);
    await expect(page.getByText("הרשמה לקבוצות למידה").first()).toBeVisible();

    // step 1: home group
    await page.getByRole("radio", { name: "קבוצת זית" }).click();
    // step 2: student (auto-advanced)
    await expect(page.getByText("טוען חניכים…")).toBeHidden({ timeout: 15_000 });
    await page.getByRole("radio", { name: "עומר גולן" }).click();

    // step 3: multi-select with conflict prevention
    await page.getByRole("button", { name: "קבוצת צילום" }).click();
    const robot = page.getByRole("button", { name: /קבוצת רובוטיקה/ });
    await expect(robot).toBeDisabled();
    await expect(robot).toContainText("חופף עם קבוצת צילום");
    // music (touching slots, different day) stays selectable
    const music = page.getByRole("button", { name: /קבוצת מוזיקה/ });
    await expect(music).toBeEnabled();
  });

  test("non-overlapping selection submits and auto-creates memberships", async ({ page }) => {
    await page.goto(`/lg-registration/${DEV_TOKEN}`);
    await page.getByRole("radio", { name: "קבוצת זית" }).click();
    await expect(page.getByText("טוען חניכים…")).toBeHidden({ timeout: 15_000 });
    await page.getByRole("radio", { name: "עומר גולן" }).click();

    // the student may already have a registration in this window (edit/resubmit
    // prefill) — ensure מוזיקה ends up selected regardless of prior state
    await expect(page.getByRole("button", { name: "קבוצת מוזיקה" })).toBeVisible();
    await page.waitForTimeout(1000); // let the best-effort prefill settle
    const music = page.getByRole("button", { name: "קבוצת מוזיקה" });
    if ((await music.getAttribute("aria-pressed")) !== "true") {
      await music.click();
    }

    await page.getByRole("button", { name: "לסיכום" }).click();
    await page.getByRole("button", { name: "אישור ושליחה" }).click();
    await expect(page.getByText("ההרשמה נשלחה בהצלחה")).toBeVisible();

    // the staff group detail page now lists the student
    await loginAndGoTo(page, USERS.mentor, "/groups/learning/66666666-6666-6666-6666-666666666603");
    await expect(page.getByText("עומר גולן")).toBeVisible();
    await logout(page);
  });

  test("direct submission of overlapping groups is rejected server-side", async ({
    request,
  }) => {
    // bypass the wizard entirely: craft the RPC call with an overlapping pair
    const anonKey = process.env.E2E_SUPABASE_ANON_KEY;
    const supabaseUrl = process.env.E2E_SUPABASE_URL;
    test.skip(
      !anonKey || !supabaseUrl,
      "E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY not configured"
    );
    const res = await request.post(`${supabaseUrl}/rest/v1/rpc/public_lgreg_submit`, {
      headers: {
        apikey: anonKey!,
        Authorization: `Bearer ${anonKey!}`,
        "Content-Type": "application/json",
      },
      data: {
        p_token: DEV_TOKEN,
        p_student_id: "44444444-4444-4444-4444-444444444401", // נועם (זית)
        p_home_group_id: "22222222-2222-2222-2222-222222222201",
        p_selected_group_ids: [
          "66666666-6666-6666-6666-666666666601", // צילום (Mon 16:00–17:30)
          "66666666-6666-6666-6666-666666666602", // רובוטיקה (Mon 16:00–17:30)
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.message).toContain("חופפת");
  });
});
