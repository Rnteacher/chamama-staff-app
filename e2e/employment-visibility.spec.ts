import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";
import { getE2eAdminClient } from "./test-db-guard";

/**
 * Student page Employment section:
 *   youngest cohort (default) → no section for anyone; managers get only the
 *     separate "הוספה לתעסוקה" action; once added the section appears.
 *   older cohorts → the section always appears, informational only.
 *   NO allow/deny eligibility control anywhere on the student page.
 * Seed: "קבוצת שקד" is the youngest cohort (default-ineligible).
 */
test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");
test.describe.configure({ mode: "serial" });

const YOUNG_NO_RECORDS = "44444444-4444-4444-4444-444444444406"; // שחר ויסמן (שקד)
const YOUNG_WITH_RECORDS = "44444444-4444-4444-4444-444444444405"; // ליאו הלוי (שקד, placement + 200h)
const OLDER_NO_PLACEMENT = "44444444-4444-4444-4444-444444444403"; // עומר גולן (זית)
const OLDER_WITH_PLACEMENT = "44444444-4444-4444-4444-444444444401"; // נועם אבידן (זית, בית קפה החממה)

/** Reset a student's override to the cohort default (test cleanup only). */
async function clearOverride(studentId: string) {
  const { error } = await getE2eAdminClient()
    .from("student_employment_overrides")
    .delete()
    .eq("student_id", studentId);
  expect(error).toBeNull();
}

function actionDone(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"])
  );
}

async function openStudent(page: Page, user: { email: string; password: string }, id: string) {
  await login(page, user);
  await page.goto(`/students/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** No allow/deny eligibility control or explanation anywhere on the page. */
async function expectNoAllowDeny(page: Page) {
  await expect(page.getByLabel("זכאות תעסוקה ידנית")).toHaveCount(0);
  await expect(page.getByText(/לאפשר תעסוקה/)).toHaveCount(0);
  await expect(page.getByRole("option", { name: "ברירת מחדל" })).toHaveCount(0);
  await expect(page.getByText("לא נכללת בתוכנית התעסוקה")).toHaveCount(0);
  await expect(page.getByText(/לא משתתף\/ת/)).toHaveCount(0);
}

async function expectNoEmploymentSection(page: Page) {
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toHaveCount(0);
  await expect(page.getByText(/שעות \/ 200 שעות/)).toHaveCount(0);
  await expect(page.getByText("אין שיבוץ לעבודה.")).toHaveCount(0);
  await expectNoAllowDeny(page);
}

test("youngest cohort default: no Employment section for staff", async ({ page }) => {
  await openStudent(page, USERS.staff, YOUNG_NO_RECORDS);
  await expectNoEmploymentSection(page);
  await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toHaveCount(0);
});

test("youngest cohort default: manager sees no section — only the separate add action", async ({ page }) => {
  await openStudent(page, USERS.coordinator, YOUNG_NO_RECORDS);
  await expectNoEmploymentSection(page);
  await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toBeVisible();
});

test("הוספה לתעסוקה → Employment section appears for everyone, with no allow/deny inside", async ({ page }) => {
  try {
    await openStudent(page, USERS.coordinator, YOUNG_NO_RECORDS);
    const done = actionDone(page);
    await page.getByRole("button", { name: "הוספה לתעסוקה" }).click();
    await done;
    await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
    await expect(page.getByText("אין שיבוץ לעבודה.")).toBeVisible();
    await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toHaveCount(0);
    await expectNoAllowDeny(page);

    await openStudent(page, USERS.staff, YOUNG_NO_RECORDS);
    await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
    await expectNoAllowDeny(page);
  } finally {
    await clearOverride(YOUNG_NO_RECORDS);
  }
  await openStudent(page, USERS.staff, YOUNG_NO_RECORDS);
  await expectNoEmploymentSection(page);
});

test("older student: section always shown, informational only — for staff and managers", async ({ page }) => {
  for (const user of [USERS.staff, USERS.coordinator]) {
    await openStudent(page, user, OLDER_NO_PLACEMENT);
    await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
    await expect(page.getByText("אין שיבוץ לעבודה.")).toBeVisible();
    await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toHaveCount(0);
    await expectNoAllowDeny(page);

    // existing placement / details / progress still render
    await openStudent(page, user, OLDER_WITH_PLACEMENT);
    await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
    await expect(page.getByText("בית קפה החממה")).toBeVisible();
    await expect(page.getByText(/שעות \/ 200 שעות/)).toBeVisible();
    await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toHaveCount(0);
    await expectNoAllowDeny(page);
  }
});

test("legacy force-ineligible on an older student: Employment STILL shown, no add button", async ({ page }) => {
  // older cohorts are always eligible (canonical rule, migration 000008) —
  // a legacy deny row is kept but behaviorally irrelevant
  const { error } = await getE2eAdminClient()
    .from("student_employment_overrides")
    .upsert({ student_id: OLDER_NO_PLACEMENT, override: "ineligible" });
  expect(error).toBeNull();
  try {
    for (const user of [USERS.staff, USERS.coordinator]) {
      await openStudent(page, user, OLDER_NO_PLACEMENT);
      await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
      await expect(page.getByText("אין שיבוץ לעבודה.")).toBeVisible();
      await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toHaveCount(0);
      await expectNoAllowDeny(page);
    }
  } finally {
    await clearOverride(OLDER_NO_PLACEMENT);
  }
});

test("existing employment history stays accessible for a youngest-cohort student", async ({ page }) => {
  await openStudent(page, USERS.staff, YOUNG_WITH_RECORDS);
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
  await expect(page.getByText(/200 שעות/).first()).toBeVisible();
  await expectNoAllowDeny(page);
});
