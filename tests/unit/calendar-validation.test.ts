import { describe, it, expect } from "vitest";
import { calendarEventSchema } from "@/lib/validation";

const base = {
  title: "יום ספורט",
  startDate: "2026-09-21",
  startTime: "09:00",
  endDate: "2026-09-21",
  endTime: "13:00",
  isAllDay: false,
  recurrence: "none" as const,
  recurrenceUntil: "",
  audiences: [{ type: "everyone" as const }],
};

describe("calendarEventSchema", () => {
  it("accepts a valid one-hour event", () => {
    expect(calendarEventSchema.safeParse(base).success).toBe(true);
  });

  it("accepts an all-day event without times", () => {
    const res = calendarEventSchema.safeParse({
      ...base,
      isAllDay: true,
      startTime: "",
      endTime: "",
    });
    expect(res.success).toBe(true);
  });

  it("accepts a multi-day event", () => {
    const res = calendarEventSchema.safeParse({
      ...base,
      startDate: "2026-09-21",
      startTime: "09:00",
      endDate: "2026-09-23",
      endTime: "15:00",
    });
    expect(res.success).toBe(true);
  });

  it("rejects end before start on the same day", () => {
    const res = calendarEventSchema.safeParse({
      ...base,
      startTime: "13:00",
      endTime: "09:00",
    });
    expect(res.success).toBe(false);
  });

  it("rejects equal start/end on the same day", () => {
    const res = calendarEventSchema.safeParse({
      ...base,
      startTime: "10:00",
      endTime: "10:00",
    });
    expect(res.success).toBe(false);
  });

  it("rejects invalid times on timed events", () => {
    const res = calendarEventSchema.safeParse({
      ...base,
      startTime: "25:00",
    });
    expect(res.success).toBe(false);
  });

  it("requires an until date for weekly recurrence (>= first occurrence)", () => {
    expect(
      calendarEventSchema.safeParse({
        ...base,
        recurrence: "weekly",
        recurrenceUntil: "",
      }).success
    ).toBe(false);

    expect(
      calendarEventSchema.safeParse({
        ...base,
        recurrence: "weekly",
        recurrenceUntil: "2026-09-20",
      }).success
    ).toBe(false);

    expect(
      calendarEventSchema.safeParse({
        ...base,
        recurrence: "weekly",
        recurrenceUntil: "2027-06-30",
      }).success
    ).toBe(true);
  });

  it("requires at least one audience", () => {
    const res = calendarEventSchema.safeParse({ ...base, audiences: [] });
    expect(res.success).toBe(false);
  });

  it("audience rows require the matching reference", () => {
    expect(
      calendarEventSchema.safeParse({
        ...base,
        audiences: [{ type: "home_group" }],
      }).success
    ).toBe(false);

    expect(
      calendarEventSchema.safeParse({
        ...base,
        audiences: [
          {
            type: "home_group",
            greenhouseGroupId: "22222222-2222-2222-2222-222222222201",
          },
        ],
      }).success
    ).toBe(true);
  });
});
