/**
 * Employment domain helpers (pure, UI + unit-test friendly).
 * The DATABASE remains the source of truth for authorization, resolution and
 * totals; these helpers mirror canonical SQL semantics (200h target, derived
 * duration, school-year eligibility) for validation and display.
 */

export const EMPLOYMENT_TARGET_MINUTES = 12_000; // 200 שעות

/** Canonical school-year representation on students.school_year (1=א..4=ד). */
export const SCHOOL_YEAR_LABELS: Record<number, string> = {
  1: "א",
  2: "ב",
  3: "ג",
  4: "ד",
};

export const EMPLOYMENT_ELIGIBLE_YEARS: readonly number[] = [2, 3, 4];

export function schoolYearLabel(year: number | null | undefined): string {
  if (year === null || year === undefined) return "—";
  return SCHOOL_YEAR_LABELS[year] ?? "—";
}

export function isEligibleYear(year: number | null | undefined): boolean {
  return year !== null && year !== undefined && EMPLOYMENT_ELIGIBLE_YEARS.includes(year);
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
  school_year: number | null;
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
