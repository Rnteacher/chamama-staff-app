import { describe, it, expect } from "vitest";
import {
  slotsOverlap,
  slotSetsOverlap,
  firstConflict,
  describeConflictHe,
  formatWeeklySlotsHe,
  formatWeeklySlotHe,
  isValidSlotRange,
  isValidTime,
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
});
