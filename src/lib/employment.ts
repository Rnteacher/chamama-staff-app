/**
 * Employment domain helpers (pure, UI + unit-test friendly).
 * The DATABASE remains the source of truth for authorization, eligibility
 * and totals; these helpers mirror canonical SQL semantics for validation
 * and display.
 *
 * ELIGIBILITY (canonical SQL: student_employment_eligible, migration
 * 20260923000001): the home-group naming convention IS the cohort order —
 * the first meaningful Hebrew letter of the group name (a leading generic
 * "קבוצת" label is skipped). The ACTIVE home group with the LATEST letter is
 * the YOUNGEST cohort and is NOT employment-eligible; every older active
 * cohort IS. The database decides; this mirror exists for display and unit
 * tests only — never re-derive the decision in React.
 */

export const EMPLOYMENT_TARGET_MINUTES = 12_000; // 200 שעות

/**
 * Manual per-student eligibility override (tri-state — canonical SQL:
 * student_employment_overrides + student_employment_eligible, migration
 * 20260923000002). A missing row means "automatic": the cohort default.
 * "automatic" is deliberately distinct from an explicit allow/deny.
 */
export type EmploymentOverride = "eligible" | "ineligible";
export type EmploymentOverrideState = EmploymentOverride | "automatic";

export const EMPLOYMENT_OVERRIDE_LABELS: Record<EmploymentOverrideState, string> = {
  automatic: "ברירת מחדל",
  eligible: "לאפשר תעסוקה",
  ineligible: "לא לאפשר תעסוקה",
};

/**
 * Canonical effective eligibility precedence (mirrors
 * public.student_employment_eligible): 1. explicit override if present,
 * 2. otherwise the Hebrew-cohort default. Never re-derive this in React —
 * this mirror exists for validation and unit tests only.
 */
export function effectiveEmploymentEligibility(
  cohortEligible: boolean,
  override: EmploymentOverrideState
): boolean {
  if (override === "eligible") return true;
  if (override === "ineligible") return false;
  return cohortEligible;
}

/**
 * TypeScript mirror of public.hebrew_cohort_rank(): explicit Hebrew alphabet
 * rank (א=1..ת=22, final-letter forms normalized, leading "קבוצת" skipped).
 * NULL when no meaningful Hebrew letter is found — "cannot determine",
 * surfaced as an admin warning, never guessed.
 */
export function hebrewCohortRank(name: string | null | undefined): number | null {
  let v = (name ?? "").trim();
  if (v === "") return null;
  while (v.startsWith("קבוצת")) v = v.slice("קבוצת".length).trim();
  for (const ch of v) {
    switch (ch) {
      case "א": return 1;
      case "ב": return 2;
      case "ג": return 3;
      case "ד": return 4;
      case "ה": return 5;
      case "ו": return 6;
      case "ז": return 7;
      case "ח": return 8;
      case "ט": return 9;
      case "י": return 10;
      case "כ": case "ך": return 11;
      case "ל": return 12;
      case "מ": case "ם": return 13;
      case "נ": case "ן": return 14;
      case "ס": return 15;
      case "ע": return 16;
      case "פ": case "ף": return 17;
      case "צ": case "ץ": return 18;
      case "ק": return 19;
      case "ר": return 20;
      case "ש": return 21;
      case "ת": return 22;
      default:
        break; // keep scanning for the first meaningful Hebrew letter
    }
  }
  return null;
}

export const YOUNGEST_COHORT_NOTE =
  "קבוצת השנתון הצעירה — לא נכללת בתוכנית התעסוקה";

/** Admin warning for a current group whose cohort order cannot be read. */
export function cohortWarning(name: string | null | undefined): string {
  return `לא ניתן לזהות את סדר השנתון של הקבוצה ${name ?? ""}`;
}

/**
 * Derive the canonical duration (minutes) from a start/end wall-clock pair.
 * Returns null when either side is missing or the pair is invalid
 * (end <= start) — contradictory values must never be stored.
 */
export function deriveDurationMinutes(
  startTime: string,
  endTime: string
): number | null {
  const t = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (!t(startTime) || !t(endTime)) return null;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const minutes = eh * 60 + em - (sh * 60 + sm);
  return minutes > 0 ? minutes : null;
}

export interface EmploymentProgress {
  totalMinutes: number;
  targetMinutes: number;
  remainingMinutes: number;
  /** uncapped — students may exceed the target */
  percent: number;
  label: string;
  bucket: "below" | "at" | "above";
}

/** 0 / partial / exactly-200 / above-200 progress from ACTUAL logged minutes. */
export function computeEmploymentProgress(totalMinutes: number): EmploymentProgress {
  const total = Math.max(0, Math.round(totalMinutes));
  const remaining = Math.max(0, EMPLOYMENT_TARGET_MINUTES - total);
  const percent = (total / EMPLOYMENT_TARGET_MINUTES) * 100;
  return {
    totalMinutes: total,
    targetMinutes: EMPLOYMENT_TARGET_MINUTES,
    remainingMinutes: remaining,
    percent,
    label: `${formatHoursLabel(total)} / ${EMPLOYMENT_TARGET_MINUTES / 60} שעות`,
    bucket: total < EMPLOYMENT_TARGET_MINUTES ? "below" : total === EMPLOYMENT_TARGET_MINUTES ? "at" : "above",
  };
}

/** "18 שעות" / "18.5 שעות" / "0 שעות" */
export function formatHoursLabel(minutes: number): string {
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} שעות`;
}

/** Slots grouped/summarized: "יום שלישי 08:30–15:00" (reuses weekday names). */
export function formatWorkSlotsHe(
  slots: { weekday: number; start_time: string; end_time: string }[]
): string {
  const names = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  return [...slots]
    .sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time))
    .map(
      (s) =>
        `יום ${names[s.weekday] ?? "?"} ${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}`
    )
    .join(" · ");
}

export const EXCEPTION_KIND_LABELS: Record<string, string> = {
  add: "עבודה בתאריך חריג",
  cancel: "ביטול יום עבודה",
  modify: "שעות שונות",
};

export interface EmploymentOverviewData {
  eligible: boolean;
  /** tri-state manual override; null = automatic (cohort default) */
  override: EmploymentOverrideState | null;
  /** cohort context: youngest-cohort note or invalid-group-name warning */
  cohort_note: string | null;
  placement: {
    id: string;
    workplace_name: string;
    contact_name: string | null;
    contact_phone: string | null;
    start_date: string;
    end_date: string | null;
    is_active: boolean;
    notes: string | null;
  } | null;
  weekly_slots: { weekday: number; start_time: string; end_time: string }[];
  exceptions: {
    id: string;
    work_date: string;
    kind: "add" | "cancel" | "modify";
    start_time: string | null;
    end_time: string | null;
  }[];
  total_minutes: number;
  target_minutes: number;
  recent_logs: {
    id: string;
    work_date: string;
    start_time: string | null;
    end_time: string | null;
    duration_minutes: number;
    note: string | null;
  }[];
  can_manage: boolean;
}
