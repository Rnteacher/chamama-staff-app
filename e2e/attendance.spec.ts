import { test, expect, type Page, type Locator } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";
import { getE2eAdminClient } from "./test-db-guard";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

/**
 * Daily attendance — operational UX correction pass.
 *
 * Covers:
 *  1. DISCOVERABILITY — every navigation happens through visible UI only
 *     (home cards, group pages, top navigation). No URL typing.
 *  2. INSTANT interaction — UI advances BEFORE the (artificially delayed)
 *     network mutation completes; rapid multi-student marking does not block;
 *     failed saves are visible and retriable; reload shows persisted state.
 *  3. Learning Group attendance is equally immediate.
 *
 * Environment: test-only local stack (see test-db-guard) — production untouched.
 */

const GROUP_ZION = "22222222-2222-2222-2222-222222222201";
const GROUP_SHAKED = "22222222-2222-2222-2222-222222222202";
const LG_PHOTO = "66666666-6666-6666-6666-666666666601";
const LG_ROBOT = "66666666-6666-6666-6666-666666666602";
const PLACEMENT_LEO = "88888888-8888-8888-8888-888888888803";
const STAFF_MENTOR_MICHAL = "11111111-1111-1111-1111-111111111102";
const STAFF_EMPLOYMENT_ITAY = "11111111-1111-1111-1111-111111111105";

const NOAM = "נועם אבידן";
const MAYA = "מאיה דרורי";
const OMER = "עומר גולן";
const TALYA = "טליה ברקוביץ";
const LEAH = "ליאו הלוי";
const TEMP_STUDENT = "בדיקה זמנית";

const MOBILE = { viewport: { width: 412, height: 915 } };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

function lastWeekday(weekday: number): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const today = new Date(`${fmt.format(new Date())}T00:00:00Z`);
  const delta = (today.getUTCDay() - weekday + 7) % 7;
  return new Date(today.getTime() - delta * 86_400_000).toISOString().slice(0, 10);
}

function todayJerusalem(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function jerusalemNowHHMM(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
  return parts === "24:00" ? "00:00" : parts;
}

function isAroundNow(value: string, toleranceMinutes = 2): boolean {
  const now = jerusalemNowHHMM();
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const diff = Math.abs(toMin(value) - toMin(now));
  return diff <= toleranceMinutes || diff >= 1440 - toleranceMinutes;
}

async function loginAndGoTo(page: Page, user: { email: string; password: string }, path: string) {
  await login(page, user);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto(path);
}

/** Delay every in-page server-action POST (Next-Action header) by `ms`. */
async function delayServerActions(page: Page, ms: number) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      await new Promise((r) => setTimeout(r, ms));
      await route.continue().catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });
}

/** Abort every in-page server-action POST (forces save failure). */
async function abortServerActions(page: Page) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      await route.abort("failed").catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });
}

async function clearActionRoutes(page: Page) {
  await page.unroute("**/*");
}

// ---------------------------------------------------------------------------
// guarded admin-client helpers (local DB ONLY — guard refuses production)
// ---------------------------------------------------------------------------

type Admin = ReturnType<typeof getE2eAdminClient>;

async function studentIdByName(admin: Admin, fullName: string): Promise<string> {
  const [first, ...rest] = fullName.split(" ");
  const { data, error } = await admin
    .from("students")
    .select("id")
    .eq("first_name", first)
    .eq("last_name", rest.join(" "))
    .maybeSingle();
  if (error || !data) throw new Error(`student not found: ${fullName} (${error?.message})`);
  return data.id;
}

async function ensureTempStudent(admin: Admin): Promise<void> {
  const { data: existing } = await admin
    .from("students")
    .select("id")
    .eq("first_name", "בדיקה")
    .eq("last_name", "זמנית")
    .maybeSingle();
  if (!existing) {
    const { error } = await admin
      .from("students")
      .insert({ first_name: "בדיקה", last_name: "זמנית", group_id: GROUP_SHAKED });
    if (error && !isUniqueViolation(error.message)) {
      throw new Error(`temp student insert failed: ${error.message}`);
    }
  }
}

/**
 * Ensure-helpers tolerate unique-violation races: BOTH Playwright projects
 * run the same spec against ONE shared local DB, so the check-then-insert
 * window can be lost between projects. A duplicate here means the row
 * already exists — which is exactly the state we need.
 */
function isUniqueViolation(message: string | undefined): boolean {
  return Boolean(
    message &&
      (message.includes("duplicate key") ||
        message.includes("unique constraint") ||
        message.includes("already exists"))
  );
}

async function ensureLgMembership(admin: Admin, groupId: string, studentId: string) {
  const { data: existing } = await admin
    .from("learning_group_memberships")
    .select("id")
    .eq("learning_group_id", groupId)
    .eq("student_id", studentId)
    .is("ended_at", null)
    .maybeSingle();
  if (!existing) {
    const { error } = await admin.from("learning_group_memberships").insert({
      learning_group_id: groupId,
      student_id: studentId,
      source: "manual",
      added_by_staff_id: STAFF_MENTOR_MICHAL,
    });
    if (error && !isUniqueViolation(error.message)) {
      throw new Error(`membership insert failed: ${error.message}`);
    }
  }
}

async function ensureLeoMondayWorkException(admin: Admin, date: string) {
  const { data: existing } = await admin
    .from("student_employment_exceptions")
    .select("id")
    .eq("placement_id", PLACEMENT_LEO)
    .eq("work_date", date)
    .maybeSingle();
  if (!existing) {
    const { error } = await admin.from("student_employment_exceptions").insert({
      placement_id: PLACEMENT_LEO,
      work_date: date,
      kind: "add",
      start_time: "09:00:00",
      end_time: "14:00:00",
      created_by_staff_id: STAFF_EMPLOYMENT_ITAY,
    });
    if (error && !isUniqueViolation(error.message)) {
      throw new Error(`exception insert failed: ${error.message}`);
    }
  }
}

async function sessionCount(admin: Admin, groupId: string, date: string): Promise<number> {
  const { count } = await admin
    .from("learning_group_sessions")
    .select("id", { count: "exact", head: true })
    .eq("learning_group_id", groupId)
    .eq("session_date", date);
  return count ?? 0;
}

async function feedEventCountSince(admin: Admin, studentId: string, since: Date): Promise<number> {
  const { count } = await admin
    .from("student_feed_events")
    .select("id", { count: "exact", head: true })
    .eq("student_id", studentId)
    .gte("occurred_at", since.toISOString());
  return count ?? 0;
}

async function pushAttemptCountSince(admin: Admin, url: string, since: Date): Promise<number> {
  const iso = new Date(since.getTime() - 5_000).toISOString();
  const { data } = await admin
    .from("audit_logs")
    .select("metadata")
    .eq("action", "push_send_failed")
    .gte("created_at", iso);
  return (data ?? []).filter(
    (r) => (r as { metadata: { url?: string } }).metadata?.url === url
  ).length;
}

interface SchoolRow {
  status: string;
  arrival_time: string | null;
  updated_at: string;
}

async function schoolRow(admin: Admin, studentId: string, date: string): Promise<SchoolRow | null> {
  const { data } = await admin
    .from("school_attendance")
    .select("status, arrival_time, updated_at")
    .eq("student_id", studentId)
    .eq("attendance_date", date)
    .maybeSingle();
  return (data as SchoolRow | null) ?? null;
}

async function lgStamp(
  admin: Admin,
  groupId: string,
  date: string,
  studentId: string
): Promise<string | null> {
  const { data: sess } = await admin
    .from("learning_group_sessions")
    .select("id")
    .eq("learning_group_id", groupId)
    .eq("session_date", date)
    .maybeSingle();
  if (!sess) return null;
  const { data } = await admin
    .from("learning_group_attendance")
    .select("updated_at")
    .eq("session_id", sess.id)
    .eq("student_id", studentId)
    .maybeSingle();
  return (data as { updated_at: string } | null)?.updated_at ?? null;
}

// ---------------------------------------------------------------------------
// mobile conversational helpers
// ---------------------------------------------------------------------------

const CARD = '[aria-label="נוכחות היום"]';

async function currentCardName(page: Page): Promise<string> {
  return ((await page.locator(`${CARD} h3`).first().textContent()) ?? "").trim();
}

async function navigateToStudent(page: Page, name: string) {
  for (let i = 0; i < 10; i++) {
    if ((await currentCardName(page)) === name) return;
    await page.getByRole("button", { name: "דלג/י ›" }).click();
    await page.waitForTimeout(150);
  }
  throw new Error(`card for ${name} not reached`);
}

// ===========================================================================
// 1. DISCOVERABILITY — attendance reachable through visible UI only
// ===========================================================================
test.describe("discoverability: attendance through visible UI (no URL typing)", () => {
  test.use(MOBILE);

  test("mentor: home card → today's attendance", async ({ page }) => {
    await login(page, USERS.mentor);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

    // the home card is prominent, names the group and shows live counts
    const card = page.getByRole("link", { name: /נוכחות הקבוצה · קבוצת זית/ });
    await expect(card).toBeVisible();
    await expect(card.getByText(/\d+\/\d+ דווחו/)).toBeVisible();
    await expect(card.getByText(/\d+ חסרים/)).toBeVisible();

    await card.click();
    await page.waitForURL((u) => u.pathname === "/attendance", { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "נוכחות יומית" })).toBeVisible();
  });

  test("LG leader: home → groups → learning group → נוכחות action", async ({ page }) => {
    await login(page, USERS.mentor);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

    // home → bottom-nav קבוצות (fixed, always visible). force: the home page
    // re-renders continuously (pre-existing layout churn) which never passes
    // Playwright's 2-frame stability check on the fixed nav
    await page.locator('a[href="/groups"]').last().click({ force: true });
    await page.waitForURL((u) => u.pathname === "/groups", { timeout: 10_000 });
    await page.getByRole("link", { name: /קבוצת צילום/ }).first().click();
    await expect(page.getByRole("heading", { name: /קבוצת צילום/ })).toBeVisible();

    // clear נוכחות action on the group page (scoped to main — the top nav
    // also has a נוכחות link for mentors)
    await page.getByRole("main").getByRole("link", { name: "נוכחות", exact: true }).click();
    await page.waitForURL(
      (u) => u.pathname === `/groups/learning/${LG_PHOTO}/attendance`, { timeout: 10_000 }
    );
    await expect(page.getByRole("heading", { name: /נוכחות · קבוצת צילום/ })).toBeVisible();
  });
});

test.describe("discoverability: top navigation (desktop)", () => {
  test.use(DESKTOP);

  test("leadership: top navigation נוכחות → school-wide overview", async ({ page }) => {
    await login(page, USERS.admin);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

    await page.getByRole("navigation", { name: "תפריט עליון" }).getByRole("link", { name: "נוכחות" }).click();
    await page.waitForURL((u) => u.pathname === "/attendance/overview", { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "נוכחות יומית — סקירה" })).toBeVisible();
  });

  test("mentor: top navigation נוכחות → today's attendance", async ({ page }) => {
    await login(page, USERS.mentor);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

    await page.getByRole("navigation", { name: "תפריט עליון" }).getByRole("link", { name: "נוכחות" }).click();
    await page.waitForURL((u) => u.pathname === "/attendance", { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "נוכחות יומית" })).toBeVisible();
  });
});

// ===========================================================================
// 2. INSTANT INTERACTION — optimistic advance before the network settles
// ===========================================================================
test.describe("instant interaction: optimistic advance, rapid marking, failure retry", () => {
  test.use(MOBILE);

  test("present advances immediately despite a 3s delayed network save; reload shows persisted state", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = todayJerusalem();
    const { data: zionIds } = await admin
      .from("students")
      .select("id")
      .eq("group_id", GROUP_ZION)
      .eq("is_archived", false);
    await admin
      .from("school_attendance")
      .delete()
      .eq("attendance_date", date)
      .in("student_id", (zionIds ?? []).map((r) => r.id));

    await loginAndGoTo(page, USERS.mentor, `/attendance?group=${GROUP_ZION}&date=${date}`);
    const first = await currentCardName(page);
    const firstId = await studentIdByName(admin, first);

    // network mutation artificially delayed by 3 seconds
    await delayServerActions(page, 3000);
    const t0 = Date.now();
    await page.getByRole("button", { name: "נוכח", exact: true }).click();

    // the conversational flow advances BEFORE the network round-trip finishes
    await expect(page.locator(`${CARD} h3`).first()).not.toHaveText(first, { timeout: 1_000 });
    const elapsed = Date.now() - t0;
    expect(elapsed, "advance must be near-instant (<1.5s) with a 3s network").toBeLessThan(1_500);

    // DB eventually saves
    await clearActionRoutes(page);
    await expect
      .poll(async () => (await schoolRow(admin, firstId, date))?.status ?? null, { timeout: 15_000 })
      .toBe("present");

    // reload shows the persisted value
    await page.reload();
    await navigateToStudent(page, first);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: נוכח")).toBeVisible();
  });

  test("rapid marking of several students does not wait for N network round-trips", async ({ page }) => {
    test.setTimeout(90_000);
    const admin = getE2eAdminClient();
    const date = todayJerusalem();
    await loginAndGoTo(page, USERS.mentor, `/attendance?group=${GROUP_ZION}&date=${date}`);

    await delayServerActions(page, 1500); // each real save would take 1.5s
    const t0 = Date.now();

    // mark three students back-to-back; each advances instantly.
    // If the current card is a בעבודה card (no choices), דלג forward —
    // bounded by the queue length (דלג clamps at the end).
    const marked: { name: string; status: "present" | "absent" | "late" }[] = [];
    const clickStatus = async (status: "present" | "absent" | "late") => {
      // a בעבודה card (expected-work student) hides the choice buttons —
      // the explicit school-arrival override reveals them instantly
      const override = page.getByRole("button", { name: "הגיע/ה לבית הספר" });
      if (await override.isVisible().catch(() => false)) {
        await override.click();
      }
      const btn = page.getByRole("button", {
        name: status === "present" ? "נוכח" : status === "absent" ? "חסר" : "איחור",
        exact: true,
      });
      const name = await currentCardName(page);
      await btn.click();
      await expect(page.locator(`${CARD} h3`).first()).not.toHaveText(name, { timeout: 1_000 });
      marked.push({ name, status });
    };
    await clickStatus("present");
    await clickStatus("absent");
    await clickStatus("late");
    const elapsed = Date.now() - t0;
    // 3 network saves at 1.5s each = 4.5s; the interaction must NOT block on them
    expect(elapsed, "3 rapid marks must complete in well under one network save").toBeLessThan(1_500);

    await clearActionRoutes(page);
    for (const m of marked) {
      const id = await studentIdByName(admin, m.name);
      await expect
        .poll(async () => (await schoolRow(admin, id, date))?.status ?? null, { timeout: 20_000 })
        .toBe(m.status);
    }
  });

  test("failed save shows לא נשמר and is retriable without losing the chosen value", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = todayJerusalem();
    await loginAndGoTo(page, USERS.mentor, `/attendance?group=${GROUP_ZION}&date=${date}`);

    const first = await currentCardName(page);
    const firstId = await studentIdByName(admin, first);

    await abortServerActions(page); // every save fails
    await page.getByRole("button", { name: "נוכח", exact: true }).click();
    // flow still advances + the failure is visible
    await expect(page.locator(`${CARD} h3`).first()).not.toHaveText(first, { timeout: 1_000 });
    await expect(page.getByText("לא נשמר").first()).toBeVisible({ timeout: 5_000 });

    // go back to the failed student: chosen value (נוכח) is preserved
    await page.getByRole("button", { name: "‹ חזור/י" }).click();
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: נוכח")).toBeVisible();

    // retry succeeds once the network is restored
    await clearActionRoutes(page);
    await page.getByRole("button", { name: "נסו שוב" }).first().click();
    await expect
      .poll(async () => (await schoolRow(admin, firstId, date))?.status ?? null, { timeout: 15_000 })
      .toBe("present");
  });
});

// ===========================================================================
// A. conversational flow correctness (unchanged product rules, instant UI)
// ===========================================================================
test.describe("A. mobile school attendance flow", () => {
  test.use(MOBILE);

  test("late saves current Jerusalem time instantly and the time stays editable; absent-first reopen; single canonical row", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = todayJerusalem();
    const { data: zionIds } = await admin
      .from("students")
      .select("id")
      .eq("group_id", GROUP_ZION)
      .eq("is_archived", false);
    await admin
      .from("school_attendance")
      .delete()
      .eq("attendance_date", date)
      .in("student_id", (zionIds ?? []).map((r) => r.id));

    await loginAndGoTo(page, USERS.mentor, `/attendance?group=${GROUP_ZION}&date=${date}`);
    await expect(page.getByRole("heading", { name: "נוכחות יומית" })).toBeVisible();

    // absent saves + advances
    const absentStudent = await currentCardName(page);
    const absentId = await studentIdByName(admin, absentStudent);
    await page.getByRole("button", { name: "חסר", exact: true }).click();
    await expect(page.locator(`${CARD} h3`).first()).not.toHaveText(absentStudent, { timeout: 2_000 });

    // late: ONE tap saves with the current Jerusalem time and advances
    const lateStudent = await currentCardName(page);
    const lateId = await studentIdByName(admin, lateStudent);
    await page.getByRole("button", { name: "איחור", exact: true }).click();
    await expect(page.locator(`${CARD} h3`).first()).not.toHaveText(lateStudent, { timeout: 2_000 });

    await expect
      .poll(async () => {
        const row = await schoolRow(admin, lateId, date);
        const t = row?.status === "late" ? (row.arrival_time?.slice(0, 5) ?? "") : "";
        return isAroundNow(t) ? "ok" : t;
      }, { timeout: 15_000 })
      .toBe("ok");

    // reload: ABSENT appears FIRST on reopen
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: חסר")).toBeVisible();
    expect(await currentCardName(page)).toBe(absentStudent);

    // the late time is editable on the late student's card
    await navigateToStudent(page, lateStudent);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: איחור")).toBeVisible();
    await page.locator(`${CARD} input[type="time"]`).fill("09:12");
    await page.locator(CARD).getByRole("button", { name: "עדכון שעה" }).click();
    await expect
      .poll(async () => (await schoolRow(admin, lateId, date))?.arrival_time?.slice(0, 5) ?? "", {
        timeout: 15_000,
      })
      .toBe("09:12");
    // editing the time does NOT create a second row (single canonical record)
    expect((await schoolRow(admin, lateId, date))?.status).toBe("late");

    // חסר → נוכח updates the SAME record
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: חסר")).toBeVisible();
    await page.getByRole("button", { name: "נוכח", exact: true }).click();
    await expect
      .poll(async () => (await schoolRow(admin, absentId, date))?.status ?? null, { timeout: 15_000 })
      .toBe("present");
  });
});

// ===========================================================================
// E/F. LEARNING GROUP attendance + propagation + feed + alerts
// ===========================================================================
test.describe("E/F. learning group: propagation, materialization, feed + alerts", () => {
  test.use(MOBILE);

  test("school-absent propagates and pre-resolves; session materialization is lazy + idempotent", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(0);
    const mayaId = await studentIdByName(admin, MAYA);
    await ensureLgMembership(admin, LG_PHOTO, mayaId);
    await admin
      .from("learning_group_sessions")
      .delete()
      .eq("learning_group_id", LG_PHOTO)
      .eq("session_date", date);

    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(0);

    await loginAndGoTo(page, USERS.mentor, `/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    await expect(page.getByRole("heading", { name: /נוכחות · קבוצת צילום/ })).toBeVisible();
    await expect(page.getByText("מפגש 16:00–17:30")).toBeVisible();
    await expect(page.getByText(NOAM)).toBeVisible();
    await expect(page.getByText(MAYA)).toBeVisible();
    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(0);

    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await navigateToStudent(page, NOAM);
    await page.getByRole("button", { name: "חסר", exact: true }).click();
    await expect
      .poll(async () => (await schoolRow(admin, await studentIdByName(admin, NOAM), date))?.status ?? null, {
        timeout: 15_000,
      })
      .toBe("absent");

    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const noamRow = page.locator("li").filter({ hasText: NOAM });
    await expect(noamRow.getByText("חסר/ה מבית הספר")).toBeVisible();
    await expect(noamRow.getByText("אין צורך לסמן")).toBeVisible();
    await expect(noamRow.getByRole("button", { name: "נוכח", exact: true })).toHaveCount(0);
    await expect(noamRow.getByRole("button", { name: "חסר", exact: true })).toHaveCount(0);
    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(0);
  });

  test("at-school absence/late: ONE feed item + ONE mentor notification; idempotent; resolves on present; LG marking is instant", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(0);
    const mayaId = await studentIdByName(admin, MAYA);
    await ensureLgMembership(admin, LG_PHOTO, mayaId);
    await admin
      .from("learning_group_sessions")
      .delete()
      .eq("learning_group_id", LG_PHOTO)
      .eq("session_date", date);
    await admin.from("student_feed_events").delete().eq("student_id", mayaId);
    await admin.from("push_subscriptions").upsert(
      {
        endpoint: "http://127.0.0.1:9/e2e-attendance-probe",
        staff_id: STAFF_MENTOR_MICHAL,
        p256dh: "invalid-e2e-key",
        auth: "invalid-e2e-auth",
      },
      { onConflict: "endpoint" }
    );
    const t0 = new Date();
    const deepLink = `/students/${mayaId}`;

    await loginAndGoTo(page, USERS.mentor, `/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const mayaRow = page.locator("li").filter({ hasText: MAYA });

    // INSTANT: with a 3s delayed network the row flips to חסר immediately
    await delayServerActions(page, 3000);
    await mayaRow.getByRole("button", { name: "חסר", exact: true }).click();
    await expect(mayaRow.getByText("חסר", { exact: true }).first()).toBeVisible({ timeout: 1_000 });
    await clearActionRoutes(page);

    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBeNull();

    // exactly ONE feed event and ONE mentor-notification attempt
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(1);
    expect(await pushAttemptCountSince(admin, deepLink, t0)).toBe(1);
    await page.goto(`/students/${mayaId}`);
    await expect(page.getByText("נעדר/ה מקבוצת הלמידה קבוצת צילום")).toBeVisible();

    // session materialized lazily; repeated opening adds nothing
    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(1);
    await page.reload();
    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(1);

    // saving the SAME state again → no duplicate feed item, no re-notification
    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const stamp1 = await lgStamp(admin, LG_PHOTO, date, mayaId);
    await mayaRow.getByRole("button", { name: "חסר", exact: true }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp1);
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(1);
    expect(await pushAttemptCountSince(admin, deepLink, t0)).toBe(1);

    // absent→late transition: still ONE event, second notification attempt
    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const stamp2 = await lgStamp(admin, LG_PHOTO, date, mayaId);
    await mayaRow.getByRole("button", { name: "איחור", exact: true }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp2);
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(1);
    await expect
      .poll(async () => await pushAttemptCountSince(admin, deepLink, t0), { timeout: 15_000 })
      .toBe(2);

    // late-time edit UPDATES the same event — no duplicate, no new notification
    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const stamp3 = await lgStamp(admin, LG_PHOTO, date, mayaId);
    await mayaRow.getByRole("button", { name: "איחור", exact: true }).click(); // instant re-mark
    await mayaRow.locator('input[type="time"]').fill("16:40");
    await mayaRow.getByRole("button", { name: "עדכון שעה" }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp3);
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(1);
    await expect
      .poll(async () => await pushAttemptCountSince(admin, deepLink, t0), { timeout: 15_000 })
      .toBe(2);
    await expect
      .poll(async () => {
        const { data: evts } = await admin
          .from("student_feed_events")
          .select("body")
          .eq("student_id", mayaId);
        return (evts ?? []).some((e) => (e as { body: string | null }).body?.includes("16:40"));
      }, { timeout: 15_000 })
      .toBe(true);

    // change to present → the event resolves and disappears from the feed
    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const stamp4 = await lgStamp(admin, LG_PHOTO, date, mayaId);
    await mayaRow.getByRole("button", { name: "נוכח", exact: true }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp4);
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(0);
    await expect
      .poll(async () => await pushAttemptCountSince(admin, deepLink, t0), { timeout: 15_000 })
      .toBe(2);
    await page.goto(`/students/${mayaId}`);
    await expect(page.getByText("איחר/ה לקבוצת הלמידה קבוצת צילום")).toHaveCount(0);
  });
});

// ===========================================================================
// D. DESKTOP attendance table (instant rows + one batch mutation)
// ===========================================================================
test.describe("D. desktop attendance table + bulk", () => {
  test.use(DESKTOP);

  test("instant row updates; late time editable; bulk marks only unresolved — never absent/late/work", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(0);
    await ensureTempStudent(admin);

    await loginAndGoTo(page, USERS.admin, `/attendance?group=${GROUP_SHAKED}&date=${date}`);
    await expect(page.getByRole("table")).toBeVisible();

    const names: string[] = [];
    for (const r of await page.getByRole("row").all()) {
      if ((await r.locator("td").count()) === 9) {
        names.push(((await r.locator("td").nth(0).textContent()) ?? "").trim());
      }
    }
    expect(names.length).toBe(5);
    expect(names).toContain(LEAH);
    expect(names).toContain(TEMP_STUDENT);
    const rowByName = (name: string) => page.getByRole("row").filter({ hasText: name });
    const statusCell = (row: Locator) => row.locator("td").nth(2);
    const nonWork = names.filter((n) => n !== LEAH && n !== TEMP_STUDENT);
    expect(nonWork.length).toBe(3);

    // ליאו is expected at work (derived from employment)
    await expect(statusCell(rowByName(LEAH))).toHaveText(/בעבודה/);
    await expect(rowByName(LEAH).locator("td").nth(1)).toContainText("משתלת חממה דרום");

    // INSTANT rows with a delayed network
    await delayServerActions(page, 3000);
    const t0 = Date.now();
    await rowByName(nonWork[0]).getByRole("button", { name: "נוכח", exact: true }).click();
    await expect(statusCell(rowByName(nonWork[0]))).toHaveText(/נוכח/, { timeout: 1_000 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    await rowByName(nonWork[1]).getByRole("button", { name: "חסר", exact: true }).click();
    await expect(statusCell(rowByName(nonWork[1]))).toHaveText(/חסר/, { timeout: 1_000 });
    await clearActionRoutes(page);

    // late: instant mark + editable inline time
    await rowByName(nonWork[2]).getByRole("button", { name: "איחור", exact: true }).click();
    const timeInput = rowByName(nonWork[2]).locator('input[type="time"]');
    await expect(timeInput).toBeVisible();
    const prefill = await timeInput.inputValue();
    expect(isAroundNow(prefill)).toBe(true);
    await timeInput.fill("08:45");
    await rowByName(nonWork[2]).getByRole("button", { name: "שמירת שעה" }).click();
    await expect
      .poll(
        async () => {
          const id = await studentIdByName(admin, nonWork[2]);
          const r = await schoolRow(admin, id, date);
          return `${r?.status ?? "none"}:${r?.arrival_time?.slice(0, 5) ?? ""}`;
        },
        { timeout: 15_000 }
      )
      .toBe("late:08:45");
    await expect(statusCell(rowByName(nonWork[2]))).toHaveText(/איחור/);

    // re-runnable: leave exactly ONE unmarked non-work student for the bulk
    const tempId = await studentIdByName(admin, TEMP_STUDENT);
    if (await schoolRow(admin, tempId, date)) {
      await rowByName(TEMP_STUDENT).getByRole("button", { name: "נקה" }).click();
      await expect
        .poll(async () => await schoolRow(admin, tempId, date), { timeout: 15_000 })
        .toBeNull();
    }

    // bulk: ONE batch mutation; absent/late/work untouched
    const tBulk = new Date();
    await page.getByRole("button", { name: "סמן את כל מי שלא סומן כנוכח" }).click();
    await page.getByRole("button", { name: "אישור" }).click();
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("audit_logs")
          .select("metadata")
          .eq("action", "school_attendance_updated")
          .gte("created_at", tBulk.toISOString());
        return (data ?? []).some(
          (r) => (r as { metadata: { bulk_present?: boolean } }).metadata?.bulk_present === true
        );
      }, { timeout: 30_000 })
      .toBe(true);
    await expect(page.getByText("סומנו 1 חניכים כנוכחים")).toBeVisible({ timeout: 20_000 });
    await expect(statusCell(rowByName(nonWork[1]))).toHaveText(/חסר/);
    await expect(statusCell(rowByName(nonWork[2]))).toHaveText(/איחור/);
    await expect(rowByName(nonWork[2]).locator("td").nth(3)).toHaveText("08:45");
    await expect(statusCell(rowByName(LEAH))).toHaveText(/בעבודה/);
    await expect(statusCell(rowByName(TEMP_STUDENT))).toHaveText(/נוכח/);
  });
});

// ===========================================================================
// E2. LG authorization + work propagation (desktop viewport)
// ===========================================================================
test.describe("E2. learning group authorization + work propagation", () => {
  test.use(DESKTOP);

  test("expected-work student shows בעבודה (no redundant marking); unrelated staff is read-only", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(1);
    await ensureLeoMondayWorkException(admin, date);
    const mayaId = await studentIdByName(admin, MAYA);
    await ensureLgMembership(admin, LG_ROBOT, mayaId);
    await admin
      .from("school_attendance")
      .delete()
      .eq("student_id", mayaId)
      .eq("attendance_date", date);

    await loginAndGoTo(page, USERS.admin, `/groups/learning/${LG_ROBOT}/attendance?date=${date}`);
    const leoRow = page.locator("li").filter({ hasText: LEAH });
    await expect(leoRow.getByText("בעבודה", { exact: true })).toBeVisible();
    await expect(leoRow.getByText("אין צורך לסמן")).toBeVisible();
    await expect(leoRow.getByRole("button", { name: "נוכח", exact: true })).toHaveCount(0);
    await expect(
      page.locator("li").filter({ hasText: MAYA }).getByRole("button", { name: "חסר", exact: true })
    ).toBeVisible();

    // unrelated staff: fresh session via a cookie-clearing context replay
    await page.context().clearCookies();
    await loginAndGoTo(page, USERS.staff, `/groups/learning/${LG_ROBOT}/attendance?date=${date}`);
    await expect(page.getByText(LEAH)).toBeVisible();
    await expect(page.getByRole("button", { name: "נוכח", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "חסר", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "איחור", exact: true })).toHaveCount(0);
  });
});

// ===========================================================================
// G. LEADERSHIP OVERVIEW (desktop, last Sunday — the D-test final state)
// ===========================================================================
test.describe("G. leadership overview", () => {
  test.use(DESKTOP);

  test("counts render correctly and group drill-down works", async ({ page }) => {
    const date = lastWeekday(0);
    await loginAndGoTo(page, USERS.admin, `/attendance/overview?date=${date}`);

    await expect(page.getByRole("heading", { name: "נוכחות יומית — סקירה" })).toBeVisible();
    const shakedRow = page.getByRole("row").filter({ hasText: "קבוצת שקד" });
    await expect(shakedRow.locator("td").nth(1)).toHaveText("5"); // total
    await expect(shakedRow.locator("td").nth(2)).toHaveText("4"); // reported
    await expect(shakedRow.locator("td").nth(3)).toHaveText("2"); // present
    await expect(shakedRow.locator("td").nth(4)).toHaveText("1"); // absent
    await expect(shakedRow.locator("td").nth(5)).toHaveText("1"); // late
    await expect(shakedRow.locator("td").nth(6)).toHaveText("1"); // working
    await expect(shakedRow.locator("td").nth(7)).toHaveText("0"); // unresolved

    await shakedRow.getByRole("link", { name: "פתיחה ›" }).click();
    await page.waitForURL(
      (u) => u.searchParams.get("group") === GROUP_SHAKED && u.searchParams.get("date") === date,
      { timeout: 10_000 }
    );
    await expect(page.getByRole("table")).toBeVisible();
  });
});
