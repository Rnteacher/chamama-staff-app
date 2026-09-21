import { describe, it, expect } from "vitest";
import {
  ATTENDANCE_STATUS_LABELS,
  EFFECTIVE_STATUS_LABELS,
  LG_SCHOOL_CONTEXT_LABELS,
  attendanceCounts,
  formatPlanHe,
  formatReportedProgressHe,
  isAtSchool,
  jerusalemNowHHMM,
  normalizeDbTime,
  reopenRank,
  sortRosterForReopen,
  type EffectiveSchoolStatus,
  type SchoolAttendanceRosterRow,
} from "@/lib/attendance";

function eff(
  status: EffectiveSchoolStatus["status"],
  overrides: Partial<EffectiveSchoolStatus> = {}
): EffectiveSchoolStatus {
  return {
    student_id: "00000000-0000-0000-0000-000000000001",
    date: "2026-09-21",
    status,
    recorded: status !== "unresolved" && status !== "expected_work",
    arrival_time: null,
    attendance_id: null,
    recorded_by_staff_id: null,
    recorded_at: null,
    updated_at: null,
    expected_work: status === "expected_work",
    workplace_name: null,
    work_start_time: null,
    work_end_time: null,
    work_overridden: false,
    planned_late_arrival_time: null,
    planned_early_departure_time: null,
    plan_reason: null,
    plan_id: null,
    ...overrides,
  };
}

function row(
  id: string,
  first: string,
  last: string,
  status: EffectiveSchoolStatus["status"],
  overrides: Partial<EffectiveSchoolStatus> = {}
): SchoolAttendanceRosterRow {
  return {
    student_id: id,
    first_name: first,
    last_name: last,
    effective: eff(status, { student_id: id, ...overrides }),
  };
}

describe("attendance status labels", () => {
  it("uses the product vocabulary (נוכח/חסר/איחור/בעבודה/טרם דווח)", () => {
    expect(ATTENDANCE_STATUS_LABELS).toEqual({
      present: "נוכח", absent: "חסר", late: "איחור",
    });
    expect(EFFECTIVE_STATUS_LABELS.expected_work).toBe("בעבודה");
    expect(EFFECTIVE_STATUS_LABELS.unresolved).toBe("טרם דווח");
  });

  it("labels the school→LG propagation contexts", () => {
    expect(LG_SCHOOL_CONTEXT_LABELS.absent_from_school).toBe("חסר/ה מבית הספר");
    expect(LG_SCHOOL_CONTEXT_LABELS.expected_work).toBe("בעבודה");
  });
});

describe("reopen ordering — absent students sort FIRST", () => {
  it("ranks absent < late < unresolved < present < expected_work", () => {
    expect(reopenRank("absent")).toBeLessThan(reopenRank("late"));
    expect(reopenRank("late")).toBeLessThan(reopenRank("unresolved"));
    expect(reopenRank("unresolved")).toBeLessThan(reopenRank("present"));
    expect(reopenRank("present")).toBeLessThan(reopenRank("expected_work"));
  });

  it("puts a student marked absent first on reopen (חסר → איחור flow)", () => {
    const rows = [
      row("3", "אבי", "אלמוג", "present"),
      row("1", "בני", "בר", "absent"),
      row("2", "גדי", "גל", "unresolved"),
      row("4", "דנה", "דרור", "expected_work"),
      row("5", "הילה", "הל", "late"),
    ];
    const sorted = sortRosterForReopen(rows);
    expect(sorted.map((r) => r.effective.status)).toEqual([
      "absent", "late", "unresolved", "present", "expected_work",
    ]);
  });

  it("breaks ties alphabetically within the same rank", () => {
    const rows = [
      row("2", "בני", "בר", "absent"),
      row("1", "אבי", "אלמוג", "absent"),
    ];
    expect(sortRosterForReopen(rows)[0].first_name).toBe("אבי");
  });

  it("does not mutate the input array", () => {
    const rows = [row("1", "א", "א", "present"), row("2", "ב", "ב", "absent")];
    sortRosterForReopen(rows);
    expect(rows[0].effective.status).toBe("present");
  });
});

describe("attendance counts", () => {
  it("counts expected-work students as resolved but NOT reported", () => {
    const counts = attendanceCounts([
      row("1", "א", "א", "present"),
      row("2", "ב", "ב", "absent"),
      row("3", "ג", "ג", "late"),
      row("4", "ד", "ד", "expected_work"),
      row("5", "ה", "ה", "expected_work"),
      row("6", "ו", "ו", "unresolved"),
    ]);
    expect(counts).toEqual({
      total: 6, present: 1, absent: 1, late: 1,
      working: 2, unresolved: 1, reported: 3, resolved: 5,
    });
    // "18 מתוך 22 דווחו" style progress
    expect(formatReportedProgressHe(counts)).toBe("5 מתוך 6 דווחו");
  });

  it("handles an empty roster", () => {
    const c = attendanceCounts([]);
    expect(c.total).toBe(0);
    expect(c.resolved).toBe(0);
  });
});

describe("planned day formatting — plans are context, never attendance", () => {
  it("formats arrival + departure + reason", () => {
    expect(
      formatPlanHe({
        planned_late_arrival_time: "10:30:00",
        planned_early_departure_time: "13:00:00",
        plan_reason: "בדיקת רופא",
      })
    ).toBe("הגעה מתוכננת 10:30 · יציאה מתוכננת 13:00 · בדיקת רופא");
  });

  it("formats a departure-only plan", () => {
    expect(
      formatPlanHe({
        planned_late_arrival_time: null,
        planned_early_departure_time: "13:00:00",
        plan_reason: "טיפול",
      })
    ).toBe("יציאה מתוכננת 13:00 · טיפול");
  });

  it("returns an empty string when there is no plan", () => {
    expect(
      formatPlanHe({ planned_late_arrival_time: null, planned_early_departure_time: null, plan_reason: null })
    ).toBe("");
  });
});

describe("timezone semantics", () => {
  it("normalizes Postgres time to HH:MM", () => {
    expect(normalizeDbTime("10:30:00")).toBe("10:30");
    expect(normalizeDbTime("10:30")).toBe("10:30");
    expect(normalizeDbTime(null)).toBeNull();
  });

  it("current time for late arrival is Jerusalem wall-clock HH:MM", () => {
    const now = jerusalemNowHHMM();
    expect(now).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });
});

describe("at-school rule for LG alerts", () => {
  it("only present/late/unresolved count as at school", () => {
    expect(isAtSchool("present")).toBe(true);
    expect(isAtSchool("late")).toBe(true);
    expect(isAtSchool("unresolved")).toBe(true);
    // absent from school and expected-at-work never alert mentors
    expect(isAtSchool("absent")).toBe(false);
    expect(isAtSchool("expected_work")).toBe(false);
  });
});
