import { describe, it, expect } from "vitest";
import { learningGroupSchema, learningGroupWindowSchema } from "@/lib/validation";

const validSlot = { weekday: 1, startTime: "16:00", endTime: "17:30" };

describe("learningGroupSchema", () => {
  it("accepts a valid group with one slot", () => {
    const res = learningGroupSchema.safeParse({
      name: "קבוצת צילום",
      isActive: true,
      slots: [validSlot],
      staffLeaderIds: [],
      studentLeaderIds: [],
    });
    expect(res.success).toBe(true);
  });

  it("requires a name", () => {
    const res = learningGroupSchema.safeParse({
      name: "  ",
      isActive: true,
      slots: [validSlot],
      staffLeaderIds: [],
      studentLeaderIds: [],
    });
    expect(res.success).toBe(false);
  });

  it("requires at least one time slot", () => {
    const res = learningGroupSchema.safeParse({
      name: "קבוצה",
      isActive: true,
      slots: [],
      staffLeaderIds: [],
      studentLeaderIds: [],
    });
    expect(res.success).toBe(false);
  });

  it("rejects end <= start", () => {
    const res = learningGroupSchema.safeParse({
      name: "קבוצה",
      isActive: true,
      slots: [{ weekday: 1, startTime: "17:30", endTime: "16:00" }],
      staffLeaderIds: [],
      studentLeaderIds: [],
    });
    expect(res.success).toBe(false);
  });

  it("rejects invalid times", () => {
    const res = learningGroupSchema.safeParse({
      name: "קבוצה",
      isActive: true,
      slots: [{ weekday: 1, startTime: "25:00", endTime: "26:00" }],
      staffLeaderIds: [],
      studentLeaderIds: [],
    });
    expect(res.success).toBe(false);
  });

  it("rejects duplicate identical slots", () => {
    const res = learningGroupSchema.safeParse({
      name: "קבוצה",
      isActive: true,
      slots: [validSlot, { ...validSlot }],
      staffLeaderIds: [],
      studentLeaderIds: [],
    });
    expect(res.success).toBe(false);
  });

  it("allows multiple slots and multiple leaders", () => {
    const res = learningGroupSchema.safeParse({
      name: "קבוצה",
      isActive: true,
      slots: [
        validSlot,
        { weekday: 0, startTime: "16:00", endTime: "17:30" },
        { weekday: 3, startTime: "10:00", endTime: "11:00" },
        { weekday: 3, startTime: "11:00", endTime: "12:00" }, // touching — valid
      ],
      staffLeaderIds: [
        "11111111-1111-1111-1111-111111111102",
        "11111111-1111-1111-1111-111111111103",
      ],
      studentLeaderIds: ["44444444-4444-4444-4444-444444444401"],
    });
    expect(res.success).toBe(true);
  });
});

describe("learningGroupWindowSchema", () => {
  it("requires title, times and at least one selectable group", () => {
    expect(
      learningGroupWindowSchema.safeParse({
        title: "הרשמה",
        opensAt: "2026-09-21T08:00",
        closesAt: "2026-09-30T23:59",
        learningGroupIds: ["66666666-6666-6666-6666-666666666601"],
      }).success
    ).toBe(true);

    expect(
      learningGroupWindowSchema.safeParse({
        title: "הרשמה",
        opensAt: "2026-09-21T08:00",
        closesAt: "2026-09-30T23:59",
        learningGroupIds: [],
      }).success
    ).toBe(false);

    expect(
      learningGroupWindowSchema.safeParse({
        title: "הרשמה",
        opensAt: "2026-10-01T08:00",
        closesAt: "2026-09-30T23:59",
        learningGroupIds: ["66666666-6666-6666-6666-666666666601"],
      }).success
    ).toBe(false);
  });
});
