import { describe, it, expect } from "vitest";
import {
  schoolWeekStart,
  isInSchoolWeek,
  slotInstant,
  meetingDeepLink,
  isValidTime,
  jerusalemWallTimeToUtc,
  WEEKDAY_SHORT_LABELS,
} from "@/lib/meetings";

/**
 * School-week semantics: Sunday 00:00 → Saturday 23:59 in Asia/Jerusalem.
 * September = IDT (UTC+3); January = IST (UTC+2) — DST correctness matters.
 */
describe("schoolWeekStart", () => {
  it("maps a mid-week instant to that week's Sunday", () => {
    // Tue 2026-09-15 10:00 UTC = Tue 13:00 Jerusalem → week starts Sun 2026-09-13
    expect(schoolWeekStart(new Date("2026-09-15T10:00:00Z"))).toBe("2026-09-13");
  });

  it("keeps Saturday night in the same school week", () => {
    // Sat 2026-09-19 00:01 Jerusalem (= Fri 21:01 UTC) → same week
    expect(schoolWeekStart(new Date("2026-09-18T21:01:00Z"))).toBe("2026-09-13");
  });

  it("rolls over at Sunday 00:00 Jerusalem", () => {
    // Sun 2026-09-20 00:00 Jerusalem (= Sat 21:00 UTC) → NEW week
    expect(schoolWeekStart(new Date("2026-09-19T21:00:00Z"))).toBe("2026-09-20");
  });

  it("handles Friday evening just before rollover", () => {
    expect(schoolWeekStart(new Date("2026-09-18T20:59:00Z"))).toBe("2026-09-13");
  });
});

describe("isInSchoolWeek", () => {
  it("is consistent with schoolWeekStart", () => {
    const week = "2026-09-13";
    expect(isInSchoolWeek(new Date("2026-09-15T10:00:00Z"), week)).toBe(true);
    expect(isInSchoolWeek(new Date("2026-09-19T21:01:00Z"), week)).toBe(false); // next Sunday
    expect(isInSchoolWeek(new Date("2026-09-10T06:00:00Z"), week)).toBe(false); // previous Thursday
  });
});

describe("slotInstant (DST-aware weekly slot resolution)", () => {
  it("resolves a summer (IDT, UTC+3) slot", () => {
    // Sun 2026-09-13 09:30 Jerusalem = 06:30 UTC
    expect(slotInstant("2026-09-13", 0, "09:30").toISOString()).toBe(
      "2026-09-13T06:30:00.000Z"
    );
  });

  it("resolves a winter (IST, UTC+2) slot", () => {
    // Sun 2026-01-04 09:30 Jerusalem = 07:30 UTC
    expect(slotInstant("2026-01-04", 0, "09:30").toISOString()).toBe(
      "2026-01-04T07:30:00.000Z"
    );
  });

  it("resolves a mid-week weekday offset (Sunday-based)", () => {
    // Wednesday of the week starting 2026-09-13 → 2026-09-16, 16:00 = 13:00 UTC
    expect(slotInstant("2026-09-13", 3, "16:00").toISOString()).toBe(
      "2026-09-16T13:00:00.000Z"
    );
  });
});

describe("jerusalemWallTimeToUtc round-trip", () => {
  it("round-trips through jerusalemParts", () => {
    const utc = jerusalemWallTimeToUtc(2026, 9, 13, 9, 30);
    expect(utc.toISOString()).toBe("2026-09-13T06:30:00.000Z");
  });
});

describe("meetingDeepLink", () => {
  it("deep-links to the student page with the meeting report action", () => {
    expect(
      meetingDeepLink("44444444-4444-4444-4444-444444444401", "55555555-5555-5555-5555-555555555501")
    ).toBe("/students/44444444-4444-4444-4444-444444444401?meeting=55555555-5555-5555-5555-555555555501&report=1");
  });
});

describe("isValidTime", () => {
  it("accepts 24h HH:MM and rejects junk", () => {
    expect(isValidTime("09:30")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("9:30")).toBe(false);
    expect(isValidTime("abc")).toBe(false);
  });
});

describe("WEEKDAY_SHORT_LABELS", () => {
  it("starts at Sunday and has 7 Hebrew day labels", () => {
    expect(WEEKDAY_SHORT_LABELS[0]).toBe("יום א׳");
    expect(WEEKDAY_SHORT_LABELS).toHaveLength(7);
  });
});
