import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";

/**
 * Student page: the Employment section exists only when employment applies
 * (canonical effective eligibility, or existing employment records) — for
 * every viewer, managers included. Managers add a student to employment from
 * OUTSIDE the section ("הוספה לתעסוקה" → force-eligible override). Seed:
 * "קבוצת שקד" is the youngest cohort (default-ineligible).
 */
test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");
test.describe.configure({ mode: "serial" });

const YOUNG_NO_RECORDS = "44444444-4444-4444-4444-444444444406"; // שחר ויסמן (שקד)
const YOUNG_WITH_RECORDS = "44444444-4444-4444-4444-444444444405"; // ליאו הלוי (שקד, placement + 200h)
const OLDER_ELIGIBLE = "44444444-4444-4444-4444-444444444403"; // עומר גולן (זית)

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

async function expectNoEmploymentSection(page: Page) {
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toHaveCount(0);
  await expect(page.getByText(/שעות \/ 200 שעות/)).toHaveCount(0);
  await expect(page.getByText("לא נכללת בתוכנית התעסוקה")).toHaveCount(0);
  await expect(page.getByText("אין שיבוץ לעבודה.")).toHaveCount(0);
  await expect(page.getByLabel("זכאות תעסוקה ידנית")).toHaveCount(0);
}

/** Manager changes the override with the control inside a visible section. */
async function setOverrideInSection(page: Page, id: string, label: string) {
  await openStudent(page, USERS.coordinator, id);
  await page.getByLabel("זכאות תעסוקה ידנית").selectOption({ label });
  const saved = actionDone(page);
  await page.getByRole("button", { name: "שמירה" }).click();
  await saved;
}

test("youngest cohort, automatic: no employment reference for staff", async ({ page }) => {
  await openStudent(page, USERS.staff, YOUNG_NO_RECORDS);
  await expectNoEmploymentSection(page);
  await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toHaveCount(0);
});

test("youngest cohort, automatic: no section for a manager either — only the add action", async ({ page }) => {
  await openStudent(page, USERS.coordinator, YOUNG_NO_RECORDS);
  await expectNoEmploymentSection(page);
  await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toBeVisible();
});

test("הוספה לתעסוקה → Employment appears for everyone; reset → gone again", async ({ page }) => {
  await openStudent(page, USERS.coordinator, YOUNG_NO_RECORDS);
  const done = actionDone(page);
  await page.getByRole("button", { name: "הוספה לתעסוקה" }).click();
  await done;
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
  await expect(page.getByText("אין שיבוץ לעבודה.")).toBeVisible();
  await expect(page.getByRole("button", { name: "הוספה לתעסוקה" })).toHaveCount(0);

  await openStudent(page, USERS.staff, YOUNG_NO_RECORDS);
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();

  // back to the cohort default
  await setOverrideInSection(page, YOUNG_NO_RECORDS, "ברירת מחדל");
  await openStudent(page, USERS.staff, YOUNG_NO_RECORDS);
  await expectNoEmploymentSection(page);
});

test("older cohort: shown automatically; forced ineligible → hidden for all; restore", async ({ page }) => {
  await openStudent(page, USERS.staff, OLDER_ELIGIBLE);
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();

  await setOverrideInSection(page, OLDER_ELIGIBLE, "לא לאפשר תעסוקה");
  await openStudent(page, USERS.staff, OLDER_ELIGIBLE);
  await expectNoEmploymentSection(page);
  await openStudent(page, USERS.coordinator, OLDER_ELIGIBLE);
  await expectNoEmploymentSection(page);

  // restore: add back (force eligible), then return to the cohort default
  const done = actionDone(page);
  await page.getByRole("button", { name: "הוספה לתעסוקה" }).click();
  await done;
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
  await setOverrideInSection(page, OLDER_ELIGIBLE, "ברירת מחדל");
  await openStudent(page, USERS.staff, OLDER_ELIGIBLE);
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
});

test("existing employment records stay reachable for a youngest-cohort student", async ({ page }) => {
  await openStudent(page, USERS.staff, YOUNG_WITH_RECORDS);
  await expect(page.getByRole("heading", { name: "תעסוקה" })).toBeVisible();
  await expect(page.getByText("לא משתתף/ת כרגע בתוכנית התעסוקה.")).toBeVisible();
  await expect(page.getByText(/200 שעות/).first()).toBeVisible();
});
