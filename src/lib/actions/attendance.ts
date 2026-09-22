"use server";

import { revalidatePath } from "next/cache";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  schoolAttendanceMarkSchema,
  studentDayPlanSchema,
  lgAttendanceSaveSchema,
  isUuid,
} from "@/lib/validation";
import type { ActionState } from "@/lib/actions/messages";
import { assertNotViewAs } from "@/lib/view-as";
import { sendPushToUsers } from "@/lib/push/send";

/**
 * Daily attendance — server actions (phase 4).
 *
 * Authorization is enforced INSIDE the security-definer RPCs (migration
 * 20260922000002); these actions only pre-validate input, block View-As
 * mutations, and route side effects (mentor push notifications).
 *
 *   * school attendance + day plans: home-group mentor | leadership | super_admin
 *   * LG attendance: staff leader of THAT group | leadership | super_admin
 *   * View-As: read-only — assertNotViewAs before any mutation.
 */

export type AttendanceMutationResult =
  | { ok: true; alertCreated?: boolean }
  | { ok: false; error: string };

function errMessage(msg: string): string {
  if (msg.includes("Not authorized") || msg.includes("Only a mentor") || msg.includes("Only a staff leader")) {
    return "אין הרשאה לרישום נוכחות";
  }
  if (msg.includes("not found") || msg.includes("not exist")) return "הרשומה לא נמצאה";
  if (msg.includes("החניך/ה לא נמצא")) return msg;
  return msg || "הפעולה נכשלה. נסו שוב.";
}

function revalidateAttendance(studentId?: string | null, groupId?: string | null) {
  revalidatePath("/attendance");
  revalidatePath("/attendance/overview");
  revalidatePath("/");
  if (groupId && isUuid(groupId)) revalidatePath(`/groups/learning/${groupId}/attendance`);
  if (studentId && isUuid(studentId)) revalidatePath(`/students/${studentId}`);
}

// ------------------------------------------------------- school attendance --

/**
 * FAST per-mark mutation for the optimistic attendance UI: NO
 * revalidatePath/refresh round-trip in the critical interaction loop. The UI
 * advances immediately from local state and persists in the background;
 * authorization stays inside the RPC and View-As stays blocked.
 */
export async function markSchoolAttendanceFastAction(input: {
  studentId: string;
  date: string;
  status: "present" | "absent" | "late";
  arrivalTime?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה לרישום נוכחות" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const parsed = schoolAttendanceMarkSchema.safeParse({
      studentId: input.studentId,
      date: input.date,
      status: input.status,
      arrivalTime: (input.arrivalTime ?? "").slice(0, 5),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const p = parsed.data;

    const supabase = await createClient();
    const { error } = await supabase.rpc("school_attendance_mark", {
      p_student_id: p.studentId,
      p_date: p.date,
      p_status: p.status,
      p_arrival_time: p.status === "late" ? `${p.arrivalTime}:00` : null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

/**
 * FAST LG per-mark mutation for the optimistic LG UI (no route refresh in the
 * interaction loop). The idempotent alert side effects + mentor push still
 * run server-side; revalidation happens when the UI queue drains.
 */
export async function saveLearningGroupAttendanceFastAction(input: {
  groupId: string;
  date: string;
  startTime: string;
  endTime: string;
  studentId: string;
  status: "present" | "absent" | "late";
  arrivalTime?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה לרישום נוכחות" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const parsed = lgAttendanceSaveSchema.safeParse({
      groupId: input.groupId,
      date: input.date,
      startTime: input.startTime.slice(0, 5),
      endTime: input.endTime.slice(0, 5),
      studentId: input.studentId,
      status: input.status,
      arrivalTime: (input.arrivalTime ?? "").slice(0, 5),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const p = parsed.data;

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("learning_group_attendance_save", {
      p_group_id: p.groupId,
      p_session_date: p.date,
      p_start_time: `${p.startTime}:00`,
      p_end_time: `${p.endTime}:00`,
      p_student_id: p.studentId,
      p_status: p.status,
      p_arrival_time: p.status === "late" ? `${p.arrivalTime}:00` : null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };

    const res = (data ?? {}) as {
      alert_created?: boolean;
      alert_type?: string | null;
      mentor_ids?: string[];
    };

    if (
      res.alert_created &&
      (res.alert_type === "absent" || res.alert_type === "late") &&
      (res.mentor_ids ?? []).length > 0
    ) {
      await sendLgAlertPush(p.studentId, p.groupId, res.alert_type, p.arrivalTime, res.mentor_ids!)
        .catch(() => undefined);
    }
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function markSchoolAttendanceAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<AttendanceMutationResult> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה לרישום נוכחות" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const parsed = schoolAttendanceMarkSchema.safeParse({
      studentId: String(fd.get("studentId") ?? ""),
      date: String(fd.get("date") ?? ""),
      status: String(fd.get("status") ?? ""),
      arrivalTime: String(fd.get("arrivalTime") ?? "").slice(0, 5),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const p = parsed.data;

    const supabase = await createClient();
    const { error } = await supabase.rpc("school_attendance_mark", {
      p_student_id: p.studentId,
      p_date: p.date,
      p_status: p.status,
      p_arrival_time: p.status === "late" ? `${p.arrivalTime}:00` : null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };

    revalidateAttendance(p.studentId);
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function clearSchoolAttendanceAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<AttendanceMutationResult> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const studentId = String(fd.get("studentId") ?? "");
    const date = String(fd.get("date") ?? "");
    if (!isUuid(studentId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: "קלט לא תקין" };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("school_attendance_clear", {
      p_student_id: studentId,
      p_date: date,
    });
    if (error) return { ok: false, error: errMessage(error.message) };

    revalidateAttendance(studentId);
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

/**
 * Bulk "סמן את כל מי שלא סומן כנוכח" — the RPC marks ONLY unresolved
 * students (never explicit absent/late records, never expected-work states,
 * never planned-late-arrival students). Safe by construction + confirmed in UI.
 */
export async function bulkMarkPresentAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<AttendanceMutationResult & { marked?: number }> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה לרישום נוכחות" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const groupId = String(fd.get("groupId") ?? "");
    const date = String(fd.get("date") ?? "");
    if (!isUuid(groupId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: "קלט לא תקין" };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("school_attendance_bulk_mark_present", {
      p_group_id: groupId,
      p_date: date,
    });
    if (error) return { ok: false, error: errMessage(error.message) };

    revalidateAttendance(null, groupId);
    return { ok: true, marked: Number(data ?? 0) };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// --------------------------------------------------------- student day plan --

export async function upsertStudentDayPlanAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<AttendanceMutationResult> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const parsed = studentDayPlanSchema.safeParse({
      studentId: String(fd.get("studentId") ?? ""),
      date: String(fd.get("date") ?? ""),
      lateArrival: String(fd.get("lateArrival") ?? "").slice(0, 5),
      earlyDeparture: String(fd.get("earlyDeparture") ?? "").slice(0, 5),
      reason: String(fd.get("reason") ?? ""),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const p = parsed.data;

    const supabase = await createClient();
    const { error } = await supabase.rpc("student_day_plan_upsert", {
      p_student_id: p.studentId,
      p_date: p.date,
      p_late_arrival_time: p.lateArrival === "" ? null : `${p.lateArrival}:00`,
      p_early_departure_time: p.earlyDeparture === "" ? null : `${p.earlyDeparture}:00`,
      p_reason: p.reason || null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };

    revalidateAttendance(p.studentId);
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function deleteStudentDayPlanAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<AttendanceMutationResult> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const studentId = String(fd.get("studentId") ?? "");
    const date = String(fd.get("date") ?? "");
    if (!isUuid(studentId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: "קלט לא תקין" };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("student_day_plan_delete", {
      p_student_id: studentId,
      p_date: date,
    });
    if (error) return { ok: false, error: errMessage(error.message) };

    revalidateAttendance(studentId);
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// ------------------------------------------------- learning group attendance --

/**
 * Save one LG attendance mark. The RPC resolves the school context and
 * manages the IDEMPOTENT alert linkage; the push below fires ONLY on the
 * alert transition (`alert_created`) — repeated saves never re-notify.
 * At-school LG absence/late → notify ALL current mentors of the home group.
 */
export async function saveLearningGroupAttendanceAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<AttendanceMutationResult> {
  try {
    const me = await requireMe();
    if (!me.staffId) return { ok: false, error: "אין הרשאה לרישום נוכחות" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const parsed = lgAttendanceSaveSchema.safeParse({
      groupId: String(fd.get("groupId") ?? ""),
      date: String(fd.get("date") ?? ""),
      startTime: String(fd.get("startTime") ?? "").slice(0, 5),
      endTime: String(fd.get("endTime") ?? "").slice(0, 5),
      studentId: String(fd.get("studentId") ?? ""),
      status: String(fd.get("status") ?? ""),
      arrivalTime: String(fd.get("arrivalTime") ?? "").slice(0, 5),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const p = parsed.data;

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("learning_group_attendance_save", {
      p_group_id: p.groupId,
      p_session_date: p.date,
      p_start_time: `${p.startTime}:00`,
      p_end_time: `${p.endTime}:00`,
      p_student_id: p.studentId,
      p_status: p.status,
      p_arrival_time: p.status === "late" ? `${p.arrivalTime}:00` : null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };

    const res = (data ?? {}) as {
      alert_created?: boolean;
      alert_type?: string | null;
      mentor_ids?: string[];
    };

    revalidateAttendance(p.studentId, p.groupId);

    // ONE push per transition — never on repeated saves of the same state.
    if (res.alert_created &&
        (res.alert_type === "absent" || res.alert_type === "late") &&
        (res.mentor_ids ?? []).length > 0) {
      await sendLgAlertPush(p.studentId, p.groupId, res.alert_type, p.arrivalTime, res.mentor_ids!)
        .catch(() => undefined);
    }
    return { ok: true, alertCreated: Boolean(res.alert_created) };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

async function sendLgAlertPush(
  studentId: string,
  groupId: string,
  alertType: "absent" | "late",
  arrivalTime: string,
  mentorIds: string[]
): Promise<void> {
  const supabase = await createClient();
  const [{ data: student }, { data: group }, { data: settingRows }] = await Promise.all([
    supabase.from("students").select("first_name, last_name").eq("id", studentId).maybeSingle(),
    supabase.from("learning_groups").select("name").eq("id", groupId).maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "include_student_name_in_push").maybeSingle(),
  ]);

  const includeName = settingRows?.value === true;
  const groupName = group?.name ?? "קבוצת למידה";
  const studentName = student ? `${student.first_name} ${student.last_name}` : "";
  const studentLabel = includeName && studentName ? `${studentName}: ` : "חניך/ה: ";
  const timeSuffix = alertType === "late" ? ` (הגיע/ה ב־${arrivalTime})` : "";
  const title = alertType === "absent" ? "היעדרות מקבוצת למידה" : "איחור לקבוצת למידה";
  const body = `${studentLabel}${alertType === "absent" ? "נעדר/ה" : "איחר/ה"} מ${groupName}${timeSuffix}`;

  await sendPushToUsers(mentorIds, {
    title,
    body,
    url: `/students/${studentId}`,
    tag: `lg_attendance:${groupId}:${studentId}:${alertType}`,
  });
}
