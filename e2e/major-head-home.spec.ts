import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";
import { getE2eAdminClient } from "./test-db-guard";

/**
 * Home "החניכים שלי" includes the students of every major the person heads
 * (canonical major_heads → major → students; project major first, else the
 * student's own major). Roles grant nothing; View-As follows the simulated
 * person. Seed: רוני (staff + major head) heads תקשורת; רונן is super_admin
 * and heads nothing; מדעי המחשב stands in for "High-Tech".
 */
test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");
test.describe.configure({ mode: "serial" });

const PASSWORD = "Chamama2026!";
const RONI = { email: "roni@chamama.example", password: PASSWORD }; // major head only
const MAJOR = {
  communication: "33333333-3333-3333-3333-333333333301", // תקשורת (רוני)
  biotech: "33333333-3333-3333-3333-333333333302", // ביוטכנולוגיה (ליאת)
  hightech: "33333333-3333-3333-3333-333333333303", // מדעי המחשב ≈ High-Tech
};
const STAFF = {
  ronen: "11111111-1111-1111-1111-111111111101", // super_admin
  michal: "11111111-1111-1111-1111-111111111102", // mentor
  naama: "11111111-1111-1111-1111-111111111104", // master
  roni: "11111111-1111-1111-1111-111111111106",
};

const admin = () => getE2eAdminClient();
const added: { major_id: string; staff_id: string }[] = [];

async function addHead(staffId: string, majorId: string) {
  const { error } = await admin().from("major_heads").insert({ major_id: majorId, staff_id: staffId });
  expect(error).toBeNull();
  added.push({ major_id: majorId, staff_id: staffId });
}

test.afterEach(async () => {
  while (added.length > 0) {
    const r = added.pop()!;
    await admin().from("major_heads").delete().eq("major_id", r.major_id).eq("staff_id", r.staff_id);
  }
});

/** Canonical student set of the given majors (project major first). */
async function studentsOf(...majorIds: string[]): Promise<Set<string>> {
  const [{ data: students }, { data: projects }] = await Promise.all([
    admin().from("students").select("id, major_id").eq("is_archived", false),
    admin().from("student_projects").select("student_id, major_id"),
  ]);
  const projectMajor = new Map((projects ?? []).map((p) => [p.student_id as string, p.major_id as string | null]));
  const ids = (students ?? [])
    .filter((s) => {
      const major = projectMajor.has(s.id) ? projectMajor.get(s.id) : s.major_id;
      return major != null && majorIds.includes(major);
    })
    .map((s) => s.id as string);
  return new Set(ids);
}

const panel = (page: Page) => page.locator('section[aria-labelledby="my-students-heading"]');
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function tabs(page: Page) {
  return panel(page).getByRole("tab").allTextContents();
}

async function listedIds(page: Page): Promise<string[]> {
  const links = isDesktop(page)
    ? panel(page).locator('table a[href^="/students/"]')
    : panel(page).locator('ul a[href^="/students/"]');
  const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  return hrefs.map((h) => h.replace("/students/", ""));
}

/** The active relationship list shows exactly `expected` (mobile: first 8 + "ועוד N"). */
async function expectStudents(page: Page, expected: Set<string>) {
  expect(expected.size).toBeGreaterThan(0);
  await expect(panel(page)).toBeVisible();
  const ids = await listedIds(page);
  expect(new Set(ids).size).toBe(ids.length); // no duplicates
  if (isDesktop(page)) {
    expect(new Set(ids)).toEqual(expected);
  } else {
    expect(ids.length).toBe(Math.min(8, expected.size));
    for (const id of ids) expect(expected.has(id)).toBe(true);
    if (expected.size > 8) {
      await expect(panel(page).getByText(`ועוד ${expected.size - 8} חניכים`)).toBeVisible();
    }
  }
}

async function home(page: Page, user: { email: string; password: string }) {
  await login(page, user);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test("major head with one major → sees all and only that major's students", async ({ page }) => {
  await home(page, RONI);
  expect(await tabs(page)).toEqual([]); // one relationship → no toggle
  if (isDesktop(page)) await expect(panel(page).getByText("החניכים שלי · מגמה")).toBeVisible();
  await expectStudents(page, await studentsOf(MAJOR.communication));
});

test("major head with several majors → union, no duplicates", async ({ page }) => {
  await addHead(STAFF.roni, MAJOR.hightech);
  await home(page, RONI);
  await expectStudents(page, await studentsOf(MAJOR.communication, MAJOR.hightech));
});

test("non-major-heads get no מגמה view (staff, mentor-only, super_admin)", async ({ page }) => {
  await home(page, USERS.staff);
  await expect(panel(page)).toHaveCount(0);

  await home(page, USERS.mentor);
  await expect(panel(page)).toBeVisible();
  expect(await tabs(page)).not.toContain("מגמה");

  // super_admin who heads no major: admin role alone grants nothing here
  await home(page, USERS.admin);
  await expect(panel(page)).toHaveCount(0);
});

test("mentor + major head → מנטור / מגמה", async ({ page }) => {
  await addHead(STAFF.michal, MAJOR.biotech);
  await home(page, USERS.mentor);
  const t = await tabs(page);
  expect(t[0]).toBe("מנטור");
  expect(t).toContain("מגמה");
  await panel(page).getByRole("tab", { name: "מגמה" }).click();
  await expect(panel(page).getByRole("tab", { name: "מגמה" })).toHaveAttribute("aria-selected", "true");
  await expectStudents(page, await studentsOf(MAJOR.biotech));
});

test("master + major head → מאסטר / מגמה", async ({ page }) => {
  await addHead(STAFF.naama, MAJOR.biotech);
  await home(page, USERS.master);
  expect(await tabs(page)).toEqual(["מאסטר", "מגמה"]);
  await panel(page).getByRole("tab", { name: "מגמה" }).click();
  await expectStudents(page, await studentsOf(MAJOR.biotech));
});

test("Tal/High-Tech equivalent: a super_admin who heads the major sees every student of it", async ({ page }) => {
  await addHead(STAFF.ronen, MAJOR.hightech);
  await home(page, USERS.admin);
  expect(await tabs(page)).toEqual([]);
  await expectStudents(page, await studentsOf(MAJOR.hightech));
});

test("View-As follows the simulated person, never the real super_admin's majors", async ({ page }) => {
  // the real super_admin heads High-Tech — none of that may leak into View-As
  await addHead(STAFF.ronen, MAJOR.hightech);
  const ronensMajor = await studentsOf(MAJOR.hightech);
  const ronisMajor = await studentsOf(MAJOR.communication);

  const enter = async (name: string, role: string) => {
    await page.goto("/admin");
    await page.getByLabel(/צפה כ־/).selectOption({ label: name });
    await page.getByLabel("בתפקיד").selectOption({ label: role });
    await page.getByRole("button", { name: "הפעלה" }).click();
    await expect(page.getByText("מצב צפייה כ־")).toBeVisible();
    await page.waitForURL((u) => u.pathname === "/");
  };
  const exit = async () => {
    await page.getByRole("button", { name: "יציאה ממצב צפייה" }).click();
    await expect(page.getByText("מצב צפייה כ־")).toHaveCount(0);
  };

  await login(page, USERS.admin);

  // simulated major head → that person's major students
  await enter("רוני מזרחי", "ראש/ית מגמה");
  // the real person's relationship toggle never renders in View-As
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator("main table")).toBeVisible();
  const hrefs = await page
    .locator('main table a[href^="/students/"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute("href") ?? "").replace("/students/", "")));
  expect(new Set(hrefs)).toEqual(ronisMajor);
  for (const id of ronensMajor) if (!ronisMajor.has(id)) expect(hrefs).not.toContain(id);
  await exit();

  // simulated ordinary staff (not a major head) → no major view at all
  await enter("תום בר", "איש/אשת צוות");
  await expect(page.getByText("תצוגת צוות כללי")).toBeVisible();
  await expect(page.locator("main table")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "מגמה" })).toHaveCount(0);
  await exit();
});
