import { describe, it, expect } from "vitest";
import {
  EMPLOYMENT_TARGET_MINUTES,
  computeEmploymentProgress,
  deriveDurationMinutes,
  formatHoursLabel,
  formatWorkSlotsHe,
  isEligibleYear,
  schoolYearLabel,
} from "@/lib/employment";
import {
  employmentPlacementSchema,
  employmentExceptionSchema,
  workLogSchema,
} from "@/lib/validation";

describe("school-year eligibility (canonical students.school_year)", () => {
  it("years ב/ג/ד are eligible", () => {
    expect(isEligibleYear(2)).toBe(true);
    expect(isEligibleYear(3)).toBe(true);
    expect(isEligibleYear(4)).toBe(true);
  });

  it("year א and unknown are not eligible", () => {
    expect(isEligibleYear(1)).toBe(false);
    expect(isEligibleYear(null)).toBe(false);
    expect(isEligibleYear(undefined)).toBe(false);
  });

  it("labels", () => {
    expect(schoolYearLabel(2)).toBe("ב");
    expect(schoolYearLabel(null)).toBe("—");
  });
});

describe("deriveDurationMinutes — canonical duration from start/end", () => {
  it("derives minutes from a valid pair", () => {
    expect(deriveDurationMinutes("08:30", "15:00")).toBe(390);
    expect(deriveDurationMinutes("09:00", "09:01")).toBe(1);
  });

  it("rejects contradictory or incomplete values", () => {
    expect(deriveDurationMinutes("15:00", "15:00")).toBeNull();
    expect(deriveDurationMinutes("15:00", "08:00")).toBeNull();
    expect(deriveDurationMinutes("", "15:00")).toBeNull();
    expect(deriveDurationMinutes("08:30", "")).toBeNull();
    expect(deriveDurationMinutes("bad", "15:00")).toBeNull();
  });
});

describe("computeEmploymentProgress — 0 / partial / exactly 200 / above", () => {
  it("zero", () => {
    const p = computeEmploymentProgress(0);
    expect(p.totalMinutes).toBe(0);
    expect(p.remainingMinutes).toBe(EMPLOYMENT_TARGET_MINUTES);
    expect(p.bucket).toBe("below");
    expect(p.percent).toBe(0);
    expect(p.label).toBe("0 שעות / 200 שעות");
  });

  it("partial", () => {
    const p = computeEmploymentProgress(690);
    expect(p.bucket).toBe("below");
    expect(p.remainingMinutes).toBe(EMPLOYMENT_TARGET_MINUTES - 690);
    expect(p.percent).toBeCloseTo(5.75);
  });

  it("exactly 200", () => {
    const p = computeEmploymentProgress(12000);
    expect(p.bucket).toBe("at");
    expect(p.remainingMinutes).toBe(0);
    expect(p.percent).toBe(100);
  });

  it("above 200 — never capped, remains the 'above' bucket", () => {
    const p = computeEmploymentProgress(12240);
    expect(p.bucket).toBe("above");
    expect(p.remainingMinutes).toBe(0);
    expect(p.percent).toBeGreaterThan(100);
  });
});

describe("formatting helpers", () => {
  it("hours label", () => {
    expect(formatHoursLabel(390)).toBe("6.5 שעות");
    expect(formatHoursLabel(720)).toBe("12 שעות");
  });

  it("slots summary is chronological by weekday then time", () => {
    expect(
      formatWorkSlotsHe([
        { weekday: 2, start_time: "08:30", end_time: "15:00" },
        { weekday: 0, start_time: "09:00", end_time: "14:00" },
      ])
    ).toBe("יום ראשון 09:00–14:00 · יום שלישי 08:30–15:00");
  });
});

describe("employmentPlacementSchema", () => {
  const base = {
    studentId: "44444444-4444-4444-4444-444444444401",
    workplaceName: "בית קפה החממה",
    contactName: "",
    contactPhone: "",
    startDate: "2026-09-01",
    endDate: "",
    notes: "",
    slots: [{ weekday: 2, startTime: "08:30", endTime: "15:00" }],
  };

  it("accepts a valid placement", () => {
    expect(employmentPlacementSchema.safeParse(base).success).toBe(true);
  });

  it("rejects endDate before startDate", () => {
    const res = employmentPlacementSchema.safeParse({
      ...base,
      endDate: "2026-08-31",
    });
    expect(res.success).toBe(false);
  });

  it("rejects slot end <= start", () => {
    const res = employmentPlacementSchema.safeParse({
      ...base,
      slots: [{ weekday: 2, startTime: "15:00", endTime: "08:30" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects missing workplace", () => {
    const res = employmentPlacementSchema.safeParse({ ...base, workplaceName: "  " });
    expect(res.success).toBe(false);
  });
});

describe("employmentExceptionSchema", () => {
  const base = {
    placementId: "88888888-8888-8888-8888-888888888802",
    workDate: "2026-09-22",
    note: "",
  };

  it("cancel must not carry times", () => {
    expect(
      employmentExceptionSchema.safeParse({ ...base, kind: "cancel", startTime: "", endTime: "" })
        .success
    ).toBe(true);
    expect(
      employmentExceptionSchema.safeParse({
        ...base,
        kind: "cancel",
        startTime: "10:00",
        endTime: "12:00",
      }).success
    ).toBe(false);
  });

  it("add/modify require a valid window", () => {
    expect(
      employmentExceptionSchema.safeParse({
        ...base,
        kind: "add",
        startTime: "10:00",
        endTime: "14:00",
      }).success
    ).toBe(true);
    expect(
      employmentExceptionSchema.safeParse({
        ...base,
        kind: "modify",
        startTime: "14:00",
        endTime: "10:00",
      }).success
    ).toBe(false);
    expect(
      employmentExceptionSchema.safeParse({ ...base, kind: "add", startTime: "", endTime: "" })
        .success
    ).toBe(false);
  });
});

describe("workLogSchema", () => {
  const base = {
    placementId: "88888888-8888-8888-8888-888888888802",
    workDate: "2026-09-21",
    note: "",
  };

  it("accepts start+end", () => {
    expect(
      workLogSchema.safeParse({ ...base, startTime: "08:30", endTime: "11:00" }).success
    ).toBe(true);
  });

  it("accepts explicit duration only", () => {
    expect(workLogSchema.safeParse({ ...base, startTime: "", endTime: "", durationMinutes: 240 }).success).toBe(true);
  });

  it("requires either times or duration", () => {
    expect(
      workLogSchema.safeParse({ ...base, startTime: "", endTime: "" }).success
    ).toBe(false);
  });

  it("rejects partial time pairs", () => {
    expect(
      workLogSchema.safeParse({ ...base, startTime: "08:30", endTime: "" }).success
    ).toBe(false);
  });
});
