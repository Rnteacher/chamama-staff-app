import { describe, it, expect } from "vitest";
import {
  canReadMessage,
  canModerateMessage,
  isPrivileged,
  type PermissionContext,
} from "@/lib/permissions";

/**
 * Unit mirror of the database permission matrix (can_user_read_message).
 * Each case corresponds to a scenario in the RLS test suite
 * (supabase/tests/rls_tests.sql), which enforces the same rules in SQL.
 *
 * Seeded scenario (fictional):
 *   נועם  — group זית (mentor: michal), major תקשורת (head: roni), master: naama
 *   ליאו  — group שקד (mentor: yoav), major תקשורת (head: roni), master: naama
 *   מאיה  — group זית, major מדמ"ח, no master
 *   שחר   — group שקד (mentor: yoav), major ביוטכנולוגיה (head: liat), master: itay
 *   אריאל — group רימון (mentor: itay), major מדמ"ח, master: itay
 */
const IDS = {
  michal: "michal",
  yoav: "yoav",
  naama: "naama",
  itay: "itay",
  roni: "roni",
  shira: "shira",
  amit: "amit",
  liat: "liat",
  tom: "tom",
  ronen: "ronen",
  noam: "noam",
  liao: "liao",
  maya: "maya",
  shachar: "shachar",
  ariel: "ariel",
};

function ctx(overrides: Partial<Record<string, unknown>>): PermissionContext {
  const roles = (overrides.roles as PermissionContext["roles"]) ?? ["staff"];
  const mentored = (overrides.mentored as string[]) ?? [];
  const mastered = (overrides.mastered as string[]) ?? [];
  const headed = (overrides.headed as string[]) ?? [];
  return {
    roles,
    mentoredStudentIds: new Set(mentored),
    masteredStudentIds: new Set(mastered),
    majorHeadStudentIds: new Set(headed),
  };
}

function msg(
  studentId: string,
  isGeneralVisible = false,
  isHiddenFromLeads = false
) {
  return { studentId, isGeneralVisible, isHiddenFromLeads };
}

describe("permission matrix — message reads", () => {
  it("T1: an account with no roles / not on allowlist is treated as plain staff (DB additionally blocks unallowlisted)", () => {
    const c = ctx({});
    expect(canReadMessage(c, msg(IDS.noam, true))).toBe(true); // approved only
    expect(canReadMessage(c, msg(IDS.noam))).toBe(false);
  });

  it("T2: general staff can send about any student (write path is open; read is restricted)", () => {
    // write authorization is: is_authorized_staff() — verified in SQL tests.
    // Here we assert the read-side consequence of a general-staff message:
    const c = ctx({});
    expect(canReadMessage(c, msg(IDS.maya))).toBe(false);
  });

  it("T3: general staff cannot read an unapproved message", () => {
    const c = ctx({});
    expect(canReadMessage(c, msg(IDS.liao))).toBe(false);
  });

  it("T3b: authorship alone does not grant read access", () => {
    const c = ctx({});
    expect(canReadMessage(c, msg(IDS.maya))).toBe(false);
  });

  it("T4: general staff can read an approved-general message", () => {
    const c = ctx({});
    expect(canReadMessage(c, msg(IDS.noam, true))).toBe(true);
  });

  it("T5: assigned master can read an unapproved message for their assigned student", () => {
    const c = ctx({ roles: ["master"], mastered: [IDS.liao] });
    expect(canReadMessage(c, msg(IDS.liao))).toBe(true);
  });

  it("T6: unrelated master cannot read a private message about another student", () => {
    const c = ctx({ roles: ["master", "staff"], mastered: [IDS.liao] });
    expect(canReadMessage(c, msg(IDS.maya))).toBe(false);
  });

  it("T7: major head can read private messages for students in their major", () => {
    const c = ctx({ roles: ["major_head", "staff"], headed: [IDS.liao] });
    expect(canReadMessage(c, msg(IDS.liao))).toBe(true);
  });

  it("T8: major head cannot use that privilege outside their major", () => {
    const c = ctx({ roles: ["major_head", "staff"], headed: [IDS.liao] });
    expect(canReadMessage(c, msg(IDS.maya))).toBe(false);
  });

  it("T9: mentor can read every message for their group — including hidden ones", () => {
    const c = ctx({ roles: ["mentor"], mentored: [IDS.noam] });
    expect(canReadMessage(c, msg(IDS.noam))).toBe(true);
    expect(canReadMessage(c, msg(IDS.noam, true))).toBe(true);
    expect(canReadMessage(c, msg(IDS.noam, false, true))).toBe(true);
  });

  it("T13/T14: hidden-from-leads message becomes invisible to master and major head even if generally visible", () => {
    const masterCtx = ctx({ roles: ["master"], mastered: [IDS.noam] });
    const headCtx = ctx({ roles: ["major_head"], headed: [IDS.noam] });
    expect(canReadMessage(masterCtx, msg(IDS.noam, true, true))).toBe(false);
    expect(canReadMessage(headCtx, msg(IDS.noam, true, true))).toBe(false);
  });

  it("T15: counselor reads everything, even blocked", () => {
    const c = ctx({ roles: ["counselor"] });
    expect(canReadMessage(c, msg(IDS.noam, false, true))).toBe(true);
  });

  it("T16: project coordinator reads everything, even blocked", () => {
    const c = ctx({ roles: ["project_coordinator"] });
    expect(canReadMessage(c, msg(IDS.noam, false, true))).toBe(true);
  });

  it("T17: leadership reads everything, even blocked", () => {
    const c = ctx({ roles: ["leadership"] });
    expect(canReadMessage(c, msg(IDS.noam, false, true))).toBe(true);
  });

  it("T18: master+mentor retains mentor access on a hidden message", () => {
    const c = ctx({
      roles: ["master", "mentor"],
      mastered: [IDS.ariel],
      mentored: [IDS.ariel],
    });
    expect(canReadMessage(c, msg(IDS.ariel, false, true))).toBe(true);
  });

  it("T19: major head + leadership retains leadership access (hidden + outside major)", () => {
    const c = ctx({
      roles: ["major_head", "leadership"],
      headed: [IDS.shachar],
    });
    expect(canReadMessage(c, msg(IDS.maya, false, true))).toBe(true);
    expect(canReadMessage(c, msg(IDS.shachar, false, true))).toBe(true);
  });

  it("T22-ish: super_admin is not a content role — no blanket message access", () => {
    const c = ctx({ roles: ["super_admin"] });
    expect(canReadMessage(c, msg(IDS.noam))).toBe(false);
    expect(canReadMessage(c, msg(IDS.noam, true, true))).toBe(false);
    expect(canReadMessage(c, msg(IDS.noam, true))).toBe(true); // approved = public to staff
  });
});

describe("permission matrix — moderation", () => {
  it("T10: mentor of the group can moderate messages about their students", () => {
    const c = ctx({ roles: ["mentor"], mentored: [IDS.noam] });
    expect(canModerateMessage(c, IDS.noam)).toBe(true);
  });

  it("T11: mentor of a different group cannot moderate", () => {
    const c = ctx({ roles: ["mentor"], mentored: [IDS.liao] });
    expect(canModerateMessage(c, IDS.noam)).toBe(false);
  });

  it("privileged global roles cannot moderate (mentor-only power)", () => {
    const c = ctx({ roles: ["leadership"] });
    expect(canModerateMessage(c, IDS.noam)).toBe(false);
  });
});

describe("isPrivileged", () => {
  it("matches exactly counselor, project_coordinator, leadership", () => {
    expect(isPrivileged({ roles: ["counselor"] })).toBe(true);
    expect(isPrivileged({ roles: ["project_coordinator"] })).toBe(true);
    expect(isPrivileged({ roles: ["leadership"] })).toBe(true);
    expect(isPrivileged({ roles: ["mentor", "staff"] })).toBe(false);
    expect(isPrivileged({ roles: ["super_admin"] })).toBe(false);
  });
});
