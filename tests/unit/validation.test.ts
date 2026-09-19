import { describe, it, expect } from "vitest";
import {
  sendMessageSchema,
  studentSchema,
  staffCreateSchema,
  subscribePushSchema,
  markMessagesReadSchema,
} from "@/lib/validation";

describe("sendMessageSchema", () => {
  it("accepts a valid message", () => {
    const res = sendMessageSchema.safeParse({
      studentId: "44444444-4444-4444-4444-444444444401",
      body: "שלום",
      isGeneralVisible: false,
      isHiddenFromLeads: false,
    });
    expect(res.success).toBe(true);
  });

  it("defaults visibility flags to false", () => {
    const res = sendMessageSchema.parse({
      studentId: "44444444-4444-4444-4444-444444444401",
      body: "שלום",
    });
    expect(res.isGeneralVisible).toBe(false);
    expect(res.isHiddenFromLeads).toBe(false);
  });

  it("rejects whitespace-only body", () => {
    const res = sendMessageSchema.safeParse({
      studentId: "44444444-4444-4444-4444-444444444401",
      body: "   ",
    });
    expect(res.success).toBe(false);
  });

  it("rejects invalid student id", () => {
    const res = sendMessageSchema.safeParse({
      studentId: "not-a-uuid",
      body: "שלום",
    });
    expect(res.success).toBe(false);
  });

  it("rejects oversized body", () => {
    const res = sendMessageSchema.safeParse({
      studentId: "44444444-4444-4444-4444-444444444401",
      body: "א".repeat(5001),
    });
    expect(res.success).toBe(false);
  });
});

describe("studentSchema", () => {
  it("requires first and last name", () => {
    expect(
      studentSchema.safeParse({
        firstName: "נועם",
        lastName: "אבידן",
        groupId: null,
        majorId: null,
      }).success
    ).toBe(true);
    expect(
      studentSchema.safeParse({ firstName: "", lastName: "אבידן" }).success
    ).toBe(false);
  });
});

describe("staffCreateSchema", () => {
  it("normalizes email case and rejects invalid emails", () => {
    const ok = staffCreateSchema.parse({
      email: "  Ronen@Chamama.Example ",
      fullName: "",
      isActive: true,
      roles: [],
    });
    expect(ok.email).toBe("ronen@chamama.example");
    expect(
      staffCreateSchema.safeParse({
        email: "nope",
        fullName: "",
        isActive: true,
        roles: [],
      }).success
    ).toBe(false);
  });
});

describe("subscribePushSchema", () => {
  it("requires endpoint url and keys", () => {
    expect(
      subscribePushSchema.safeParse({
        endpoint: "https://push.example/x",
        p256dh: "a",
        auth: "b",
      }).success
    ).toBe(true);
    expect(
      subscribePushSchema.safeParse({ endpoint: "nope", p256dh: "a", auth: "b" })
        .success
    ).toBe(false);
  });
});

describe("markMessagesReadSchema", () => {
  it("caps the batch size", () => {
    const ids = Array(501).fill("44444444-4444-4444-4444-444444444401");
    expect(markMessagesReadSchema.safeParse({ messageIds: ids }).success).toBe(false);
    expect(
      markMessagesReadSchema.safeParse({
        messageIds: ["44444444-4444-4444-4444-444444444401"],
      }).success
    ).toBe(true);
  });
});
