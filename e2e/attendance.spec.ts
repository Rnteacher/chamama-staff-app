import { test, expect, type Page, type Locator } from "@playwright/test";
import { SKIP, USERS, login, logout } from "./helpers";
import { getE2eAdminClient } from "./test-db-guard";

test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

/**
 * Daily attendance (phase 4) — ACTUALLY EXECUTED Playwright verification.
 *
 * Environment (test-only, process env — production files untouched):
 *   - the app under test is built/started with NEXT_PUBLIC_ENABLE_EMAIL_LOGIN
 *     =true and the LOCAL Supabase URL/anon key (email login stays disabled
 *     in the normal dev/prod configuration)
 *   - direct test-side DB access goes ONLY through the fail-closed guard
 *     (getE2eAdminClient) pointed at the LOCAL stack; production hosts are
 *     refused by the guard, which reads .env.local production refs first
 *
 * Every test runs in BOTH browser projects: each describe pins the viewport
 * it needs (mobile conversational / desktop table), so nothing is skipped.
 * All waits are poll-based (no fixed sleeps racing server actions), and
 * tests are re-run safe (--workers=1, sequential projects).
 *
 * Seeded facts (supabase/seed.sql):
 *   - קבוצת זית 2222..201 (mentor מיכל): נועם/טליה/עומר/מאיה
 *   - קבוצת שקד 2222..202: ליאו/שחר/רותם/אורי
 *   - ליאו employment: weekly work slot SUNDAY 09:00-14:00 (placement 8888..803)
 *   - נועם employment: weekly work slot TUESDAY 08:30-15:00 (placement 8888..802)
 *   - LG צילום 6666..601: slots Sun+Mon 16:00-17:30, member נועם, leader מיכל
 *   - LG רובוטיקה 6666..602: slot Mon 16:00-17:30, member ליאו
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
const TEMP_STUDENT = "בדיקה זמנית"; // D-only extra roster row (guarded insert)

const MOBILE = { viewport: { width: 412, height: 915 } };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

/** Most recent (≤ today) Jerusalem date with the given weekday (0=Sunday). */
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

function shiftHHMM(hhmm: string, minutes: number): string {
  const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + minutes;
  const norm = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(norm / 60)).padStart(2, "0")}:${String(norm % 60).padStart(2, "0")}`;
}

/** Accept the current Jerusalem minute ±1 (the clock may roll mid-step). */
function isAroundNow(value: string): boolean {
  const now = jerusalemNowHHMM();
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const diff = Math.abs(toMin(value) - toMin(now));
  return diff <= 1 || diff >= 1439;
}

async function loginAndGoTo(page: Page, user: { email: string; password: string }, path: string) {
  await login(page, user);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto(path);
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
    if (error) throw new Error(`temp student insert failed: ${error.message}`);
  }
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
    if (error) throw new Error(`membership insert failed: ${error.message}`);
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
    if (error) throw new Error(`exception insert failed: ${error.message}`);
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

/**
 * "Mentor notification path triggered" evidence: the local test server runs
 * with a deliberately-invalid VAPID public key (process env, test process
 * only) and the mentor has one probe push subscription with invalid device
 * keys, so EVERY push attempt fails deterministically before any network
 * I/O and writes exactly ONE `push_send_failed` audit row carrying the
 * payload deep-link URL. Counting rows created after `since` therefore
 * counts notification-path invocations.
 */
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

/** Skip forward until the card matches `name` (bounded). */
async function navigateToStudent(page: Page, name: string) {
  for (let i = 0; i < 10; i++) {
    if ((await currentCardName(page)) === name) return;
    await page.getByRole("button", { name: "דלג/י ›" }).click();
    await page.waitForTimeout(150);
  }
  throw new Error(`card for ${name} not reached`);
}

/**
 * Mark the current card and wait DETERMINISTICALLY until the write is
 * persisted (updated_at changes) — never a fixed sleep racing the action.
 */
async function markCurrent(
  page: Page,
  opts: {
    admin: Admin;
    studentId: string;
    date: string;
    status: "present" | "absent" | "late";
    lateTime?: string;
  }
) {
  const before = await schoolRow(opts.admin, opts.studentId, opts.date);
  if (opts.status === "late") {
    await page.getByRole("button", { name: "איחור", exact: true }).click();
    await page.locator(`${CARD} input[type="time"]`).fill(opts.lateTime ?? "");
    await page.locator(CARD).getByRole("button", { name: "שמירה" }).click();
  } else {
    await page
      .getByRole("button", { name: opts.status === "present" ? "נוכח" : "חסר", exact: true })
      .click();
  }
  await expect
    .poll(async () => (await schoolRow(opts.admin, opts.studentId, opts.date))?.updated_at ?? null, {
      timeout: 15_000,
    })
    .not.toBe(before?.updated_at ?? null);
  const row = await schoolRow(opts.admin, opts.studentId, opts.date);
  expect(row?.status).toBe(opts.status);
  if (opts.status === "late") {
    expect(row?.arrival_time?.slice(0, 5)).toBe(opts.lateTime);
  }
  await page.waitForTimeout(400); // let the conversational advance settle
}

// ===========================================================================
// A. MOBILE SCHOOL ATTENDANCE — conversational flow (קבוצת זית, today)
// ===========================================================================
test.describe("A. mobile school attendance", () => {
  test.use(MOBILE);

  test("present auto-advances; absent saves; late pre-fills Jerusalem time (editable); reload preserves; absent first on reopen; single canonical row", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = todayJerusalem();
    const lateTime = shiftHHMM(jerusalemNowHHMM(), -137); // unique-ish per run

    // clean slate for THIS group+date so the absent-first positional
    // assertion below is unique (other tests may mark זית students today)
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
    await expect(page.locator(CARD)).toBeVisible();

    // present auto-advances
    const firstName = await currentCardName(page);
    const firstId = await studentIdByName(admin, firstName);
    await markCurrent(page, { admin, studentId: firstId, date, status: "present" });
    const second = await currentCardName(page);
    expect(second, "present must auto-advance to the next student").not.toBe(firstName);

    // absent saves
    const absentStudent = second;
    const absentId = await studentIdByName(admin, absentStudent);
    await markCurrent(page, { admin, studentId: absentId, date, status: "absent" });
    const third = await currentCardName(page);
    expect(third).not.toBe(absentStudent);

    // late: pre-filled with the CURRENT Jerusalem time, editable, then saved
    const lateStudent = third;
    const lateId = await studentIdByName(admin, lateStudent);
    await page.getByRole("button", { name: "איחור", exact: true }).click();
    const timeInput = page.locator(`${CARD} input[type="time"]`);
    const prefill = await timeInput.inputValue();
    expect(isAroundNow(prefill), `late prefill ${prefill} must be current Jerusalem time`).toBe(true);
    await markCurrent(page, { admin, studentId: lateId, date, status: "late", lateTime });

    // reload preserves state + the ABSENT student appears FIRST on reopen
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: חסר")).toBeVisible();
    expect(await currentCardName(page)).toBe(absentStudent);

    // late record preserved with its edited arrival time
    await navigateToStudent(page, lateStudent);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: איחור")).toBeVisible();
    await expect(page.locator(CARD).getByText(`הגיע/ה ב־${lateTime}`)).toBeVisible();

    // חסר → נוכח updates the SAME record (never a duplicate row)
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: חסר")).toBeVisible();
    await markCurrent(page, { admin, studentId: absentId, date, status: "present" });

    expect((await schoolRow(admin, absentId, date))?.status).toBe("present");
    const lateRow = await schoolRow(admin, lateId, date);
    expect(lateRow?.status).toBe("late");
    expect(lateRow?.arrival_time?.slice(0, 5)).toBe(lateTime);
  });

  test("home shows נוכחות קבוצת האם entry with counts for the mentor", async ({ page }) => {
    await login(page, USERS.mentor);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "נוכחות היום" })).toBeVisible();
    const card = page.getByRole("link", { name: /נוכחות קבוצת האם · קבוצת זית/ });
    await expect(card).toBeVisible();
    await expect(card.getByText(/\d+\/\d+ דווחו/)).toBeVisible();
  });
});

// ===========================================================================
// B. EXPECTED WORK (mobile, קבוצת זית, last Tuesday — נועם works 08:30-15:00)
// ===========================================================================
test.describe("B. expected work integration", () => {
  test.use(MOBILE);

  test("בעבודה card is skipped by default; הגיע/ה לבית הספר override works; employment data unchanged", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(2); // Tuesday
    const noamId = await studentIdByName(admin, NOAM);
    // re-runnable: start from the derived work state (no explicit report yet)
    await admin
      .from("school_attendance")
      .delete()
      .eq("student_id", noamId)
      .eq("attendance_date", date);

    const { data: placeBefore } = await admin
      .from("student_employment_placements")
      .select("id, updated_at")
      .eq("student_id", noamId)
      .eq("is_active", true)
      .maybeSingle();

    await loginAndGoTo(page, USERS.mentor, `/attendance?group=${GROUP_ZION}&date=${date}`);

    // skip to the בעבודה card (expected-work students sort last)
    let workCard = false;
    for (let i = 0; i < 10; i++) {
      if (
        await page
          .getByRole("button", { name: "הגיע/ה לבית הספר" })
          .isVisible()
          .catch(() => false)
      ) {
        workCard = true;
        break;
      }
      await page.getByRole("button", { name: "דלג/י ›" }).click();
      await page.waitForTimeout(150);
    }
    expect(workCard, "נועם must be displayed as the בעבודה card").toBe(true);

    // compact בעבודה card: workplace context, NO attendance choices by default
    await expect(page.locator(CARD).getByText("בעבודה", { exact: true }).first()).toBeVisible();
    await expect(page.locator(CARD).getByText("אין צורך לדווח נוכחות")).toBeVisible();
    await expect(page.locator(CARD).getByText("בית קפה החממה")).toBeVisible();
    await expect(page.getByRole("button", { name: "נוכח", exact: true })).toHaveCount(0);

    // explicit school-arrival override → normal actual attendance
    await page.getByRole("button", { name: "הגיע/ה לבית הספר" }).click();
    await expect(page.getByRole("button", { name: "נוכח", exact: true })).toBeVisible();
    await markCurrent(page, { admin, studentId: noamId, date, status: "present" });

    // reload preserves the explicit attendance
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await navigateToStudent(page, NOAM);
    await expect(page.locator(CARD).getByText("סטטוס נוכחי: נוכח")).toBeVisible();

    // employment data itself remains unchanged
    expect((await schoolRow(admin, noamId, date))?.status).toBe("present");
    const { data: placeAfter } = await admin
      .from("student_employment_placements")
      .select("id, updated_at")
      .eq("student_id", noamId)
      .eq("is_active", true)
      .maybeSingle();
    expect(placeAfter?.updated_at).toBe(placeBefore?.updated_at);
  });
});

// ===========================================================================
// C. PLANNED DAY (mobile, קבוצת זית, today)
// ===========================================================================
test.describe("C. planned day", () => {
  test.use(MOBILE);

  test("planned late arrival + early departure visible in attendance; plan never creates attendance", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = todayJerusalem();
    const omerId = await studentIdByName(admin, OMER);
    const talyaId = await studentIdByName(admin, TALYA);

    // login once; the clear helper re-navigates with the same session
    await loginAndGoTo(page, USERS.mentor, `/attendance?group=${GROUP_ZION}&date=${date}`);

    // clear any actual attendance left by earlier tests (plans need unresolved)
    for (const [name, id] of [
      [OMER, omerId],
      [TALYA, talyaId],
    ] as const) {
      await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
      await navigateToStudent(page, name);
      const before = await schoolRow(admin, id, date);
      if (before) {
        // the card must show the clear control for a recorded student
        await expect(page.getByRole("button", { name: "נקה דיווח" })).toBeVisible({
          timeout: 10_000,
        });
        await page.getByRole("button", { name: "נקה דיווח" }).click();
        await expect
          .poll(async () => (await schoolRow(admin, id, date))?.updated_at ?? null, {
            timeout: 15_000,
          })
          .toBe(null);
      }
    }

    // plans are managed from the STUDENT page (secondary surface)
    await page.goto(`/students/${omerId}`);
    await page.getByRole("button", { name: /הוספה|עריכה/ }).click();
    await page.getByLabel("הגעה מתוכננת").fill("10:30");
    await page.getByLabel("הסבר (רשות)").fill("בדיקת רופא");
    await page.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByText("נשמר")).toBeVisible();

    await page.goto(`/students/${talyaId}`);
    await page.getByRole("button", { name: /הוספה|עריכה/ }).click();
    await page.getByLabel("יציאה מתוכננת").fill("13:00");
    await page.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByText("נשמר")).toBeVisible();

    // plans surface prominently in the attendance screen — but are not statuses
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await navigateToStudent(page, OMER);
    await expect(page.locator(CARD).getByText("הגעה מתוכננת 10:30")).toBeVisible();
    await expect(page.locator(CARD).getByText("בדיקת רופא")).toBeVisible();
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await navigateToStudent(page, TALYA);
    await expect(page.locator(CARD).getByText("יציאה מתוכננת 13:00")).toBeVisible();

    // a plan must NOT create actual attendance
    expect(await schoolRow(admin, omerId, date)).toBeNull();
    expect(await schoolRow(admin, talyaId, date)).toBeNull();
  });
});

// ===========================================================================
// E/F. LEARNING GROUP attendance, propagation, session materialization,
//      feed + alerts (mobile viewport, LG צילום, last Sunday)
// ===========================================================================
test.describe("E/F. learning group: propagation, materialization, feed + alerts", () => {
  test.use(MOBILE);

  test("school-absent propagates and pre-resolves; session materialization is lazy + idempotent", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(0); // Sunday — צילום slot 16:00-17:30
    const noamId = await studentIdByName(admin, NOAM);
    const mayaId = await studentIdByName(admin, MAYA);
    await ensureLgMembership(admin, LG_PHOTO, mayaId);
    // re-runnable: reset materialized sessions for THIS verification
    await admin
      .from("learning_group_sessions")
      .delete()
      .eq("learning_group_id", LG_PHOTO)
      .eq("session_date", date);

    // §3 LAZY: before ANY save there is no session row
    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(0);

    // opening the screen resolves the session from the weekly slot —
    // WITHOUT creating one
    await loginAndGoTo(page, USERS.mentor, `/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    await expect(page.getByRole("heading", { name: /נוכחות · קבוצת צילום/ })).toBeVisible();
    await expect(page.getByText("מפגש 16:00–17:30")).toBeVisible();
    await expect(page.getByText(NOAM)).toBeVisible();
    await expect(page.getByText(MAYA)).toBeVisible();
    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(0);

    // school says ABSENT for נועם (daily attendance, same date)
    await page.goto(`/attendance?group=${GROUP_ZION}&date=${date}`);
    await navigateToStudent(page, NOAM);
    await markCurrent(page, { admin, studentId: noamId, date, status: "absent" });

    // LG screen reflects the school absence automatically — pre-resolved
    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const noamRow = page.locator("li").filter({ hasText: NOAM });
    await expect(noamRow.getByText("חסר/ה מבית הספר")).toBeVisible();
    await expect(noamRow.getByText("אין צורך לסמן")).toBeVisible();
    await expect(noamRow.getByRole("button", { name: "נוכח", exact: true })).toHaveCount(0);
    await expect(noamRow.getByRole("button", { name: "חסר", exact: true })).toHaveCount(0);

    // read path still never materializes
    expect(await sessionCount(admin, LG_PHOTO, date)).toBe(0);
  });

  test("at-school absence/late: ONE feed item + ONE mentor notification; idempotent; resolves on present", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(0);
    const mayaId = await studentIdByName(admin, MAYA);
    await ensureLgMembership(admin, LG_PHOTO, mayaId);
    // re-runnable: clean LG state + prior feed events for this student
    await admin
      .from("learning_group_sessions")
      .delete()
      .eq("learning_group_id", LG_PHOTO)
      .eq("session_date", date);
    await admin.from("student_feed_events").delete().eq("student_id", mayaId);
    // notification-trace probe (see pushAttemptCountSince): one invalid
    // subscription → exactly one audit row per push-path invocation
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

    // absent (maya has no school record → at school)
    await loginAndGoTo(page, USERS.mentor, `/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const mayaRow = page.locator("li").filter({ hasText: MAYA });
    const stamp0 = await lgStamp(admin, LG_PHOTO, date, mayaId);
    await mayaRow.getByRole("button", { name: "חסר", exact: true }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp0);

    // exactly ONE feed event and ONE mentor-notification attempt
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(1);
    expect(await pushAttemptCountSince(admin, deepLink, t0)).toBe(1);
    // the item lives on the SAME unified student feed
    await page.goto(`/students/${mayaId}`);
    await expect(page.getByText("נעדר/ה מקבוצת הלמידה קבוצת צילום")).toBeVisible();

    // session materialized lazily by the save; repeated opening adds nothing
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
    await mayaRow.locator('input[type="time"]').fill("16:22");
    await mayaRow.getByRole("button", { name: "שמירה" }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp2);
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(1);
    expect(await pushAttemptCountSince(admin, deepLink, t0)).toBe(2);
    await page.goto(`/students/${mayaId}`);
    await expect(page.getByText("איחר/ה לקבוצת הלמידה קבוצת צילום")).toBeVisible();

    // late-time edit UPDATES the same event — no duplicate, no new notification
    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const stamp3 = await lgStamp(admin, LG_PHOTO, date, mayaId);
    await mayaRow.getByRole("button", { name: "איחור", exact: true }).click();
    await mayaRow.locator('input[type="time"]').fill("16:40");
    await mayaRow.getByRole("button", { name: "שמירה" }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp3);
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(1);
    expect(await pushAttemptCountSince(admin, deepLink, t0)).toBe(2);
    const { data: events } = await admin
      .from("student_feed_events")
      .select("body")
      .eq("student_id", mayaId);
    expect(
      (events ?? []).some((e) => (e as { body: string | null }).body?.includes("16:40"))
    ).toBe(true);

    // change to present → the event resolves and disappears from the feed
    await page.goto(`/groups/learning/${LG_PHOTO}/attendance?date=${date}`);
    const stamp4 = await lgStamp(admin, LG_PHOTO, date, mayaId);
    await mayaRow.getByRole("button", { name: "נוכח", exact: true }).click();
    await expect
      .poll(async () => await lgStamp(admin, LG_PHOTO, date, mayaId), { timeout: 15_000 })
      .not.toBe(stamp4);
    expect(await feedEventCountSince(admin, mayaId, t0)).toBe(0);
    expect(await pushAttemptCountSince(admin, deepLink, t0)).toBe(2);
    await page.goto(`/students/${mayaId}`);
    await expect(page.getByText("איחר/ה לקבוצת הלמידה קבוצת צילום")).toHaveCount(0);
  });
});

// ===========================================================================
// D. DESKTOP ATTENDANCE (wide table + bulk, קבוצת שקד, last Sunday — ליאו works)
// ===========================================================================
test.describe("D. desktop attendance table + bulk", () => {
  test.use(DESKTOP);

  test("table renders; per-row controls; late time editable; bulk marks only unresolved — never absent/late/work", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(0); // Sunday — ליאו's weekly work day
    await ensureTempStudent(admin); // roster: ליאו + 3 seeded + 1 test-only row

    await loginAndGoTo(page, USERS.admin, `/attendance?group=${GROUP_SHAKED}&date=${date}`);
    await expect(page.getByRole("table")).toBeVisible();
    for (const header of ["חניך/ה", "סטטוס", "שעת הגעה", "הגעה מתוכננת", "יציאה מתוכננת", "פעולות"]) {
      await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
    }

    // row map: NAMES from the initial render; all later locators are
    // content-based (rows re-sort absent-first as statuses change)
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
    // the three seeded non-work students get per-row marks; TEMP_STUDENT is
    // reserved as the single unmarked target of the bulk operation
    const nonWork = names.filter((n) => n !== LEAH && n !== TEMP_STUDENT);
    expect(nonWork.length).toBe(3);

    // ליאו is expected at work (derived from employment)
    await expect(statusCell(rowByName(LEAH))).toHaveText(/בעבודה/);
    await expect(rowByName(LEAH).locator("td").nth(1)).toContainText("משתלת חממה דרום");

    // per-row controls: present / absent / late with an editable time
    const idByName = async (name: string) => await studentIdByName(admin, name);
    await rowByName(nonWork[0]).getByRole("button", { name: "נוכח", exact: true }).click();
    await expect
      .poll(
        async () => (await schoolRow(admin, await idByName(nonWork[0]), date))?.status ?? null,
        { timeout: 15_000 }
      )
      .toBe("present");
    await rowByName(nonWork[1]).getByRole("button", { name: "חסר", exact: true }).click();
    await expect
      .poll(
        async () => (await schoolRow(admin, await idByName(nonWork[1]), date))?.status ?? null,
        { timeout: 15_000 }
      )
      .toBe("absent");
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
          const r = await schoolRow(admin, await idByName(nonWork[2]), date);
          return `${r?.status ?? "none"}:${r?.arrival_time?.slice(0, 5) ?? ""}`;
        },
        { timeout: 15_000 }
      )
      .toBe("late:08:45");

    // re-runnable: leave exactly ONE unmarked non-work student for the bulk
    // (on a fresh DB טמפ is already unmarked — clear only when recorded)
    const tempId = await studentIdByName(admin, TEMP_STUDENT);
    if (await schoolRow(admin, tempId, date)) {
      await rowByName(TEMP_STUDENT).getByRole("button", { name: "נקה" }).click();
      await expect
        .poll(async () => await schoolRow(admin, tempId, date), { timeout: 15_000 })
        .toBeNull();
    }

    // bulk: marks ONLY the unmarked non-work student; absent/late/work untouched
    const tBulk = new Date();
    await page.getByRole("button", { name: "סמן את כל מי שלא סומן כנוכח" }).click();
    await page.getByRole("button", { name: "אישור" }).click();
    // authoritative wait: the bulk writes ONE audited row (metadata.bulk_present)
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("audit_logs")
          .select("metadata")
          .eq("action", "school_attendance_updated")
          .gte("created_at", tBulk.toISOString());
        return (data ?? []).some(
          (r) =>
            (r as { metadata: { bulk_present?: boolean } }).metadata?.bulk_present === true
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
// E2. LEARNING GROUP authorization + work propagation (desktop viewport)
// ===========================================================================
test.describe("E2. learning group authorization + work propagation", () => {
  test.use(DESKTOP);

  test("expected-work student shows בעבודה (no redundant marking); unrelated staff is read-only", async ({ page }) => {
    const admin = getE2eAdminClient();
    const date = lastWeekday(1); // Monday — רובוטיקה slot + seeded one-day work exception
    await ensureLeoMondayWorkException(admin, date);
    // an at-school member so authorized leaders have a markable roster row
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
    // the at-school member (מאיה) remains markable for an authorized viewer
    await expect(
      page.locator("li").filter({ hasText: MAYA }).getByRole("button", { name: "חסר", exact: true })
    ).toBeVisible();

    // unrelated staff: NO mutation controls anywhere
    await logout(page);
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
    // D leaves שקד as: 2 present, 1 absent, 1 late, 1 working, 0 unresolved,
    // 4 reported out of 5 total (the test-only roster row included)
    await expect(shakedRow.locator("td").nth(1)).toHaveText("5"); // total
    await expect(shakedRow.locator("td").nth(2)).toHaveText("4"); // reported
    await expect(shakedRow.locator("td").nth(3)).toHaveText("2"); // present
    await expect(shakedRow.locator("td").nth(4)).toHaveText("1"); // absent
    await expect(shakedRow.locator("td").nth(5)).toHaveText("1"); // late
    await expect(shakedRow.locator("td").nth(6)).toHaveText("1"); // working
    await expect(shakedRow.locator("td").nth(7)).toHaveText("0"); // unresolved

    // drill-down opens the group's detailed table for the same date
    await shakedRow.getByRole("link", { name: "פתיחה ›" }).click();
    await page.waitForURL(
      (u) => u.searchParams.get("group") === GROUP_SHAKED && u.searchParams.get("date") === date,
      { timeout: 10_000 }
    );
    await expect(page.getByRole("table")).toBeVisible();
  });
});

test.afterEach(async ({ page }) => {
  try {
    await logout(page);
  } catch {
    /* already logged out */
  }
});
