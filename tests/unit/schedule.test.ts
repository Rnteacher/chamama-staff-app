import { describe, it, expect } from "vitest";
import {
  slotsOverlap,
  slotSetsOverlap,
  firstConflict,
  describeConflictHe,
  describeRecurrenceHe,
  formatWeeklySlotsHe,
  formatWeeklySlotHe,
  isValidSlotRange,
  isValidTime,
  normalizeTime,
  upcomingWeekdayDates,
  sortScheduleItems,
  isNow,
} from "@/lib/schedule";

const slot = (weekday: number, startTime: string, endTime: string) => ({
  weekday,
  startTime,
  endTime,
});

describe("slotsOverlap — THE shared primitive", () => {
  it("detects same-weekday overlap", () => {
    expect(slotsOverlap(slot(1, "16:00", "17:30"), slot(1, "16:30", "18:00"))).toBe(true);
  });

  it("touching boundaries are NOT a conflict (10:00–11:00 + 11:00–12:00)", () => {
    expect(slotsOverlap(slot(3, "10:00", "11:00"), slot(3, "11:00", "12:00"))).toBe(false);
  });

  it("different weekdays never conflict", () => {
    expect(slotsOverlap(slot(1, "16:00", "17:30"), slot(2, "16:00", "17:30"))).toBe(false);
  });

  it("contained slots conflict", () => {
    expect(slotsOverlap(slot(0, "16:00", "18:00"), slot(0, "17:00", "17:30"))).toBe(true);
  });

  it("identical slots conflict", () => {
    expect(slotsOverlap(slot(4, "18:00", "19:00"), slot(4, "18:00", "19:00"))).toBe(true);
  });
});

describe("slotSetsOverlap — multi-slot groups compare ALL combinations", () => {
  const photo = [slot(0, "16:00", "17:30"), slot(1, "16:00", "17:30")];

  it("conflicts when only the SECOND slot overlaps", () => {
    expect(slotSetsOverlap(photo, [slot(1, "17:00", "18:00")])).toBe(true);
  });

  it("conflicts when only the FIRST slot overlaps", () => {
    expect(slotSetsOverlap(photo, [slot(0, "15:00", "16:30")])).toBe(true);
  });

  it("no conflict when all slots are free", () => {
    expect(slotSetsOverlap(photo, [slot(3, "09:00", "10:00"), slot(2, "16:00", "17:30")])).toBe(false);
  });

  it("touching slot against a multi-slot group is accepted", () => {
    const music = [slot(3, "10:00", "11:00"), slot(3, "11:00", "12:00")];
    expect(slotSetsOverlap(music, [slot(3, "09:00", "10:00")])).toBe(false);
  });
});

describe("firstConflict — conflict UI support", () => {
  it("reports the conflicting group and the overlapping slot", () => {
    const res = firstConflict([slot(1, "16:00", "17:30")], [
      { name: "קבוצת רובוטיקה", slots: [slot(1, "16:00", "17:30")] },
    ]);
    expect(res).not.toBeNull();
    expect(res?.name).toBe("קבוצת רובוטיקה");
    expect(res?.slot).toEqual(slot(1, "16:00", "17:30"));
  });

  it("returns null without conflicts", () => {
    expect(
      firstConflict([slot(1, "16:00", "17:30")], [
        { name: "אחרת", slots: [slot(2, "16:00", "17:30")] },
      ])
    ).toBeNull();
  });
});

describe("Hebrew formatting", () => {
  it("formats a single slot", () => {
    expect(formatWeeklySlotHe(slot(1, "16:00", "17:30"))).toBe("יום שני 16:00–17:30");
  });

  it("formats multiple slots sorted by weekday then time", () => {
    expect(
      formatWeeklySlotsHe([slot(3, "10:00", "11:00"), slot(0, "16:00", "17:30")])
    ).toBe("יום ראשון 16:00–17:30 · יום רביעי 10:00–11:00");
  });

  it("describes a conflict in Hebrew", () => {
    expect(describeConflictHe("קבוצת צילום", slot(1, "16:00", "17:30"))).toBe(
      "חופף עם קבוצת צילום ביום שני 16:00–17:30"
    );
  });
});

describe("validation helpers", () => {
  it("time format", () => {
    expect(isValidTime("16:00")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("16:5")).toBe(false);
  });

  it("slot range requires end > start", () => {
    expect(isValidSlotRange(slot(1, "16:00", "17:30"))).toBe(true);
    expect(isValidSlotRange(slot(1, "16:00", "16:00"))).toBe(false);
    expect(isValidSlotRange(slot(1, "18:00", "16:00"))).toBe(false);
  });

  it("normalizes Postgres HH:MM:SS times (touching stays touching)", () => {
    expect(normalizeTime("16:00:00")).toBe("16:00");
    // without normalization "10:00" < "10:00:00" would wrongly overlap
    expect(
      slotsOverlap(slot(3, "10:00", "11:00"), slot(3, "11:00:00", "12:00"))
    ).toBe(false);
  });
});

describe("describeRecurrenceHe — Hebrew recurrence summary", () => {
  it("one-off", () => {
    expect(
      describeRecurrenceHe({ recurrence: "none", recurrenceUntil: "", startDate: "2026-09-21" })
    ).toBe("חד פעמי");
  });

  it("weekly with until", () => {
    expect(
      describeRecurrenceHe({
        recurrence: "weekly",
        recurrenceUntil: "2027-06-30",
        startDate: "2026-09-21", // Monday
      })
    ).toBe("כל שבוע ביום שני, עד 30/06/2027");
  });

  it("monthly with until", () => {
    expect(
      describeRecurrenceHe({
        recurrence: "monthly",
        recurrenceUntil: "2027-06-30",
        startDate: "2026-09-15",
      })
    ).toBe("כל חודש בתאריך 15, עד 30/06/2027");
  });
});

describe("upcomingWeekdayDates — concrete conflict-check horizon", () => {
  it("starts on the matching weekday and steps by 7", () => {
    const dates = upcomingWeekdayDates("2026-09-21", 3, 3); // Sep 21 2026 is a Monday; 3=Wednesday
    expect(dates).toEqual(["2026-09-23", "2026-09-30", "2026-10-07"]);
  });

  it("includes today when the weekday matches", () => {
    const dates = upcomingWeekdayDates("2026-09-21", 1, 2);
    expect(dates[0]).toBe("2026-09-21");
    expect(dates[1]).toBe("2026-09-28");
  });
});

describe("unified schedule item helpers", () => {
  const item = (startAt: string, endAt: string, isAllDay = false) => ({
    sourceType: "calendar_event" as const,
    sourceId: "x",
    title: "t",
    startAt,
    endAt,
    isAllDay,
    context: null,
    linkPath: null,
  });

  it("all-day items come first, then chronological", () => {
    const sorted = sortScheduleItems([
      item("2026-09-21T08:00:00Z", "2026-09-21T09:00:00Z"),
      item("2026-09-20T21:00:00Z", "2026-09-21T20:59:00Z", true), // all day IL
      item("2026-09-21T06:00:00Z", "2026-09-21T07:00:00Z"),
    ]);
    expect(sorted[0].isAllDay).toBe(true);
    expect(sorted[1].startAt).toBe("2026-09-21T06:00:00Z");
    expect(sorted[2].startAt).toBe("2026-09-21T08:00:00Z");
  });

  it("isNow marks the current item (Jerusalem instants)", () => {
    const now = new Date("2026-09-21T09:30:00Z");
    expect(isNow(item("2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"), now)).toBe(true);
    expect(isNow(item("2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z"), now)).toBe(false);
    // touching boundary: 10:00 start is NOT inside [09:00, 10:00)
    expect(isNow(item("2026-09-21T08:00:00Z", "2026-09-21T09:00:00Z"), now)).toBe(false);
  });
});
