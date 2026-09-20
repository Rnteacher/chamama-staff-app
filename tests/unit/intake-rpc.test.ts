import { describe, it, expect, vi } from "vitest";

// intake-server is server-only; neutralize the guard for unit testing
vi.mock("server-only", () => ({}));

import {
  fetchIntakeStudents,
  submitIntake,
} from "@/lib/intake-public";
import {
  fetchIntakeOverview,
  fetchIntakeMajors,
  fetchIntakeMasters,
} from "@/lib/intake-server";

/**
 * Argument-shape + response-shape tests for every public intake RPC call.
 * The Supabase client is mocked and captures the EXACT arguments passed to
 * .rpc(), proving PostgREST named-argument compatibility (p_token, ...).
 */

const TOKEN = "kX9_qW-ertyuiopasdfghjklzxcvbnm1234567890QWERTYU";
const GROUP = "22222222-2222-2222-2222-222222222201";
const STUDENT = "44444444-4444-4444-4444-444444444401";
const MASTER = "11111111-1111-1111-1111-111111111102";

function mockClient(rpcResponse: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => rpcResponse);
  const client = { rpc } as unknown as Parameters<
    typeof fetchIntakeOverview
  >[0] & { rpc: ReturnType<typeof vi.fn> };
  return { client, rpc };
}

// ------------------------------------------------------------- overview ----

describe("public_intake_overview (server helper)", () => {
  it("A: status=open object resolves OPEN and passes the exact argument", async () => {
    const { client, rpc } = mockClient({
      data: {
        status: "open",
        title: "t",
        opens_at: "2026-01-01T00:00:00+00:00",
        closes_at: "2026-01-02T00:00:00+00:00",
        groups: [{ id: GROUP, name: "קבוצת זית" }],
      },
      error: null,
    });
    const state = await fetchIntakeOverview(client, TOKEN);
    expect(state.status).toBe("open");
    expect(state.groups).toEqual([{ id: GROUP, name: "קבוצת זית" }]);
    expect(rpc).toHaveBeenCalledWith("public_intake_overview", {
      p_token: TOKEN, // exact raw token, exact parameter name
    });
  });

  it("B: RPC error (data=null) resolves ERROR — never 'invalid'", async () => {
    const { client } = mockClient({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function", details: null, hint: null },
    });
    const state = await fetchIntakeOverview(client, TOKEN);
    expect(state.status).toBe("error");
  });

  it("C: a valid DB jsonb object is NOT transformed into ERROR", async () => {
    const { client } = mockClient({ data: { status: "open", title: "t" }, error: null });
    const state = await fetchIntakeOverview(client, TOKEN);
    expect(state.status).toBe("open");
  });

  it("D: jsonb delivered as text is parsed, not treated as an unknown shape", async () => {
    const { client } = mockClient({
      data: JSON.stringify({ status: "open", title: "t" }),
      error: null,
    });
    const state = await fetchIntakeOverview(client, TOKEN);
    expect(state.status).toBe("open");
  });

  it("invalid status from the DB stays 'invalid' (genuine bad token)", async () => {
    const { client } = mockClient({ data: { status: "invalid" }, error: null });
    const state = await fetchIntakeOverview(client, TOKEN);
    expect(state.status).toBe("invalid");
  });
});

// ------------------------------------------------- majors / masters / students

describe("public_intake_majors / masters / students argument shapes", () => {
  it("majors passes { p_token }", async () => {
    const { client, rpc } = mockClient({
      data: [{ id: "m1", name: "מגמה" }],
      error: null,
    });
    const majors = await fetchIntakeMajors(client, TOKEN);
    expect(rpc).toHaveBeenCalledWith("public_intake_majors", { p_token: TOKEN });
    expect(majors).toEqual([{ id: "m1", name: "מגמה" }]);
  });

  it("masters passes { p_token } and returns name-only entries", async () => {
    const { client, rpc } = mockClient({
      data: [{ id: MASTER, name: "מיכל שרון" }],
      error: null,
    });
    const masters = await fetchIntakeMasters(client, TOKEN);
    expect(rpc).toHaveBeenCalledWith("public_intake_masters", { p_token: TOKEN });
    expect(masters).toEqual([{ id: MASTER, name: "מיכל שרון" }]);
    // no email/roles leakage in the RPC payload handling
    expect(JSON.stringify(masters)).not.toContain("email");
  });

  it("students passes { p_token, p_group_id } exactly", async () => {
    const { client, rpc } = mockClient({
      data: [{ id: STUDENT, first_name: "נועם", last_name: "אבידן" }],
      error: null,
    });
    const students = await fetchIntakeStudents(client, TOKEN, GROUP);
    expect(rpc).toHaveBeenCalledWith("public_intake_students", {
      p_token: TOKEN,
      p_group_id: GROUP,
    });
    expect(students).toEqual([{ id: STUDENT, first_name: "נועם", last_name: "אבידן" }]);
  });
});

// ----------------------------------------------------------------- submit ---

describe("public_intake_submit argument shape", () => {
  it("passes all six named arguments with לא במגמה as null major", async () => {
    const { client, rpc } = mockClient({ data: { status: "ok" }, error: null });
    const res = await submitIntake(client, {
      token: TOKEN,
      studentId: STUDENT,
      groupId: GROUP,
      intent: "כוונה",
      majorId: null,
      masterStaffId: MASTER,
    });
    expect(res.status).toBe("ok");
    expect(rpc).toHaveBeenCalledWith("public_intake_submit", {
      p_token: TOKEN,
      p_student_id: STUDENT,
      p_group_id: GROUP,
      p_intent: "כוונה",
      p_major_id: null,
      p_master_staff_id: MASTER,
    });
  });

  it("passes a chosen major id when the student selects a major", async () => {
    const { client, rpc } = mockClient({ data: { status: "ok" }, error: null });
    await submitIntake(client, {
      token: TOKEN,
      studentId: STUDENT,
      groupId: GROUP,
      intent: "כוונה",
      majorId: "33333333-3333-3333-3333-333333333301",
      masterStaffId: MASTER,
    });
    expect(rpc).toHaveBeenCalledWith("public_intake_submit", {
      p_token: TOKEN,
      p_student_id: STUDENT,
      p_group_id: GROUP,
      p_intent: "כוונה",
      p_major_id: "33333333-3333-3333-3333-333333333301",
      p_master_staff_id: MASTER,
    });
  });

  it("surfaces DB-side status/message (not_open) without throwing", async () => {
    const { client } = mockClient({
      data: { status: "not_open" },
      error: null,
    });
    const res = await submitIntake(client, {
      token: TOKEN,
      studentId: STUDENT,
      groupId: GROUP,
      intent: "כוונה",
      majorId: null,
      masterStaffId: MASTER,
    });
    expect(res.status).toBe("not_open");
  });
});
