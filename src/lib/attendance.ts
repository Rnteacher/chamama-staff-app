/**
 * Attendance domain helpers (pure, UI + unit-test friendly) — phase 4.
 *
 * THE DATABASE REMAINS THE SOURCE OF TRUTH:
 *   * effective-status precedence lives in the canonical SQL resolver
 *     public.student_effective_school_status (migration 20260922000002).
 *     These helpers only shape/label/sort that structured output for the UI —
 *     they NEVER re-derive precedence.
 *   * authorization lives in the security-definer RPCs.
 *
 * Product model mirrored here:
 *   * "working" is DERIVED from employment (expected_work) — never a
 *     manually-entered attendance status.
 *   * planned late arrival / early departure are PLANS, not actual attendance.
 *   * an explicit actual report overrides an expected-work day.
 */

import { jerusalemParts } from "@/lib/meetings";

/** Actual recorded attendance statuses. */
export type AttendanceStatus = "present" | "absent" | "late";

/**
 * Canonical effective school status (mirrors the SQL resolver output):
 * recorded statuses + the derived expected-work state + unresolved.
 */
export type EffectiveStatus = AttendanceStatus | "expected_work" | "unresolved";

/** Structured output of public.student_effective_school_status(). */
export interface EffectiveSchoolStatus {
  student_id: string;
  date: string;
  status: EffectiveStatus;
  recorded: boolean;
  arrival_time: string | null; // "HH:MM(:SS)"
  attendance_id: string | null;
  recorded_by_staff_id: string | null;
  recorded_at: string | null;
  updated_at: string | null;
  expected_work: boolean;
  workplace_name: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
  work_overridden: boolean;
  planned_late_arrival_time: string | null;
  planned_early_departure_time: string | null;
  plan_reason: string | null;
  plan_id: string | null;
}

export interface SchoolAttendanceRosterRow {
  student_id: string;
  first_name: string;
  last_name: string;
  effective: EffectiveSchoolStatus;
}

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "נוכח",
  absent: "חסר",
  late: "איחור",
};

export const EFFECTIVE_STATUS_LABELS: Record<EffectiveStatus, string> = {
  present: "נוכח",
  absent: "חסר",
  late: "איחור",
  expected_work: "בעבודה",
  unresolved: "טרם דווח",
};

/**
 * School absence / expected work propagate into the Learning Group context —
 * the leader sees WHY a mark is not needed. Never copied into LG records.
 */
export const LG_SCHOOL_CONTEXT_LABELS: Record<string, string> = {
  absent_from_school: "חסר/ה מבית הספר",
  expected_work: "בעבודה",
};

const TIME_HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Postgres `time` renders "HH:MM:SS" — normalize to the canonical "HH:MM". */
export function normalizeDbTime(t: string | null | undefined): string | null {
  if (!t) return null;
  return TIME_HM_RE.test(t) ? t : t.slice(0, 5);
}

/** Current Asia/Jerusalem wall-clock "HH:MM" (late-arrival default). */
export function jerusalemNowHHMM(now: Date = new Date()): string {
  const p = jerusalemParts(now);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Reopen ordering rank (product rule: absent students FIRST):
 *   1. absent  2. late  3. not-yet-recorded  4. present  5. expected-at-work.
 * Expected-work students count as resolved and sort last.
 */
export function reopenRank(status: EffectiveStatus): number {
  switch (status) {
    case "absent": return 0;
    case "late": return 1;
    case "unresolved": return 2;
    case "present": return 3;
    case "expected_work": return 4;
  }
}

/** Absent-first reopen ordering; ties broken alphabetically by name. */
export function sortRosterForReopen(
  rows: SchoolAttendanceRosterRow[]
): SchoolAttendanceRosterRow[] {
  return [...rows].sort((a, b) => {
    const r = reopenRank(a.effective.status) - reopenRank(b.effective.status);
    if (r !== 0) return r;
    return (a.first_name + a.last_name).localeCompare(b.first_name + b.last_name, "he");
  });
}

export interface AttendanceCounts {
  total: number;
  present: number;
  absent: number;
  late: number;
  working: number;
  unresolved: number;
  reported: number;
  /** reported + expected-work (resolved without an explicit report) */
  resolved: number;
}

/**
 * Completion counts from roster rows. Expected-work students count as
 * RESOLVED even without an attendance row (never as "reported").
 */
export function attendanceCounts(rows: SchoolAttendanceRosterRow[]): AttendanceCounts {
  const c: AttendanceCounts = {
    total: rows.length, present: 0, absent: 0, late: 0,
    working: 0, unresolved: 0, reported: 0, resolved: 0,
  };
  for (const r of rows) {
    switch (r.effective.status) {
      case "present": c.present++; c.reported++; c.resolved++; break;
      case "absent": c.absent++; c.reported++; c.resolved++; break;
      case "late": c.late++; c.reported++; c.resolved++; break;
      case "expected_work": c.working++; c.resolved++; break;
      case "unresolved": c.unresolved++; break;
    }
  }
  return c;
}

/** "18 מתוך 22 דווחו" — resolved counts expected-work as reported-for-progress. */
export function formatReportedProgressHe(counts: AttendanceCounts): string {
  return `${counts.resolved} מתוך ${counts.total} דווחו`;
}

/**
 * Planned-day context line: "הגעה מתוכננת 10:30 · יציאה מתוכננת 13:00 · סיבה".
 * Plans are context only — they never become attendance statuses.
 */
export function formatPlanHe(plan: Pick<EffectiveSchoolStatus,
  "planned_late_arrival_time" | "planned_early_departure_time" | "plan_reason">): string {
  const parts: string[] = [];
  const arr = normalizeDbTime(plan.planned_late_arrival_time);
  const dep = normalizeDbTime(plan.planned_early_departure_time);
  if (arr) parts.push(`הגעה מתוכננת ${arr}`);
  if (dep) parts.push(`יציאה מתוכננת ${dep}`);
  if (plan.plan_reason) parts.push(plan.plan_reason);
  return parts.join(" · ");
}

/** True when the student is treated as AT SCHOOL for LG alert purposes. */
export function isAtSchool(status: EffectiveStatus): boolean {
  return status === "present" || status === "late" || status === "unresolved";
}
