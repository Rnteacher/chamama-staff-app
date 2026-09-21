"use server";

import { revalidatePath } from "next/cache";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  employmentPlacementSchema,
  employmentExceptionSchema,
  workLogSchema,
  isUuid,
} from "@/lib/validation";
import type { ActionState } from "@/lib/actions/messages";
import { assertNotViewAs } from "@/lib/view-as";
import { deriveDurationMinutes } from "@/lib/employment";

/**
 * Student employment — server actions.
 *
 * Permissions (enforced here AND inside the database RPCs):
 *   * mutate employment data: employment_coordinator / leadership / super_admin
 *   * View-As: NO mutations (assertNotViewAs before anything).
 * Ordinary staff have no mutation path at all (RPC grants + checks).
 */

export type EmploymentMutationResult =
  | { ok: true; id?: string }
  | { ok: false; error: string };

function errMessage(msg: string): string {
  if (msg.includes("Only employment coordinator")) return "אין הרשאה לניהול תעסוקה";
  if (msg.includes("Not authorized")) return "אין הרשאה לניהול תעסוקה";
  if (msg.includes("not found") || msg.includes("Not found")) return "הרשומה לא נמצאה";
  return msg || "הפעולה נכשלה. נסו שוב.";
}

async function requireEmploymentManager() {
  const me = await requireMe();
  const allowed =
    me.staffId !== null &&
    (hasRole(me, "employment_coordinator") ||
      hasRole(me, "leadership") ||
      hasRole(me, "super_admin"));
  return { me, allowed };
}

function revalidateEmployment(studentId?: string | null) {
  revalidatePath("/admin/employment");
  if (studentId && isUuid(studentId)) {
    revalidatePath(`/admin/employment/${studentId}`);
    revalidatePath(`/students/${studentId}`);
  }
  revalidatePath("/");
}

// ------------------------------------------------------------ placements ---

export async function upsertEmploymentPlacementAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<EmploymentMutationResult> {
  try {
    const { allowed } = await requireEmploymentManager();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול תעסוקה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    let slots: unknown;
    try {
      slots = JSON.parse(String(fd.get("slots") ?? "[]"));
    } catch {
      return { ok: false, error: "ימי עבודה לא תקינים" };
    }

    const parsed = employmentPlacementSchema.safeParse({
      studentId: String(fd.get("studentId") ?? ""),
      workplaceName: String(fd.get("workplaceName") ?? ""),
      contactName: String(fd.get("contactName") ?? ""),
      contactPhone: String(fd.get("contactPhone") ?? ""),
      startDate: String(fd.get("startDate") ?? ""),
      endDate: String(fd.get("endDate") ?? ""),
      notes: String(fd.get("notes") ?? ""),
      slots,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const p = parsed.data;

    // authorization + eligibility + slot validation + audit happen INSIDE the RPC
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_upsert_employment_placement", {
      p_id: isUuid(String(fd.get("placementId") ?? "")) ? String(fd.get("placementId")) : null,
      p_student_id: p.studentId,
      p_workplace_name: p.workplaceName,
      p_contact_name: p.contactName || null,
      p_contact_phone: p.contactPhone || null,
      p_start_date: p.startDate,
      p_end_date: p.endDate || null,
      p_notes: p.notes || null,
      p_slots: p.slots.map((s) => ({
        weekday: s.weekday,
        start_time: `${s.startTime}:00`,
        end_time: `${s.endTime}:00`,
      })),
    });
    if (error) return { ok: false, error: errMessage(error.message) };
    const res = (data ?? {}) as { id?: string; created?: boolean };
    revalidateEmployment(p.studentId);
    return { ok: true, id: res.id };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function endEmploymentPlacementAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<EmploymentMutationResult> {
  try {
    const { allowed } = await requireEmploymentManager();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול תעסוקה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const placementId = String(fd.get("placementId") ?? "");
    const studentId = String(fd.get("studentId") ?? "");
    const endDate = String(fd.get("endDate") ?? "");
    if (!isUuid(placementId)) return { ok: false, error: "קלט לא תקין" };

    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_end_employment_placement", {
      p_placement_id: placementId,
      p_end_date: /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };
    revalidateEmployment(studentId);
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// ----------------------------------------------------------- exceptions ----

export async function upsertEmploymentExceptionAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<EmploymentMutationResult> {
  try {
    const { allowed } = await requireEmploymentManager();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול תעסוקה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const parsed = employmentExceptionSchema.safeParse({
      placementId: String(fd.get("placementId") ?? ""),
      workDate: String(fd.get("workDate") ?? ""),
      kind: String(fd.get("kind") ?? ""),
      startTime: String(fd.get("startTime") ?? ""),
      endTime: String(fd.get("endTime") ?? ""),
      note: String(fd.get("note") ?? ""),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const e = parsed.data;

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_upsert_employment_exception", {
      p_id: isUuid(String(fd.get("exceptionId") ?? "")) ? String(fd.get("exceptionId")) : null,
      p_placement_id: e.placementId,
      p_work_date: e.workDate,
      p_kind: e.kind,
      p_start_time: e.kind === "cancel" ? null : `${e.startTime}:00`,
      p_end_time: e.kind === "cancel" ? null : `${e.endTime}:00`,
      p_note: e.note || null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };
    revalidateEmployment(String(fd.get("studentId") ?? ""));
    return { ok: true, id: (data as string | null) ?? undefined };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function deleteEmploymentExceptionAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<EmploymentMutationResult> {
  try {
    const { allowed } = await requireEmploymentManager();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול תעסוקה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const id = String(fd.get("exceptionId") ?? "");
    if (!isUuid(id)) return { ok: false, error: "קלט לא תקין" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_delete_employment_exception", { p_id: id });
    if (error) return { ok: false, error: errMessage(error.message) };
    revalidateEmployment(String(fd.get("studentId") ?? ""));
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// ------------------------------------------------------------- work logs ---

/**
 * Duration derivation (canonical, server-side):
 *   start+end given → duration = end-start (a submitted duration must match)
 *   otherwise       → explicit durationMinutes required (1..720)
 */
export async function upsertWorkLogAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<EmploymentMutationResult> {
  try {
    const { allowed } = await requireEmploymentManager();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול תעסוקה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const startTime = String(fd.get("startTime") ?? "").slice(0, 5);
    const endTime = String(fd.get("endTime") ?? "").slice(0, 5);
    const durationRaw = String(fd.get("durationMinutes") ?? "").trim();

    const parsed = workLogSchema.safeParse({
      placementId: String(fd.get("placementId") ?? ""),
      workDate: String(fd.get("workDate") ?? ""),
      startTime,
      endTime,
      durationMinutes: durationRaw === "" ? undefined : Number(durationRaw),
      note: String(fd.get("note") ?? ""),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const w = parsed.data;

    let durationMinutes: number | null = null;
    if (w.startTime !== "" && w.endTime !== "") {
      durationMinutes = deriveDurationMinutes(w.startTime, w.endTime);
      if (durationMinutes === null) {
        return { ok: false, error: "שעת סיום חייבת להיות אחרי שעת ההתחלה" };
      }
    } else if (w.durationMinutes !== undefined && w.durationMinutes > 0) {
      durationMinutes = w.durationMinutes;
    } else {
      return { ok: false, error: "הזינו שעות התחלה וסיום או משך עבודה" };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_upsert_work_log", {
      p_id: isUuid(String(fd.get("workLogId") ?? "")) ? String(fd.get("workLogId")) : null,
      p_placement_id: w.placementId,
      p_work_date: w.workDate,
      p_start_time: w.startTime === "" ? null : `${w.startTime}:00`,
      p_end_time: w.endTime === "" ? null : `${w.endTime}:00`,
      p_duration_minutes: durationMinutes,
      p_note: w.note || null,
    });
    if (error) return { ok: false, error: errMessage(error.message) };
    revalidateEmployment(String(fd.get("studentId") ?? ""));
    const res = (data ?? {}) as { id?: string };
    return { ok: true, id: res.id };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function deleteWorkLogAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<EmploymentMutationResult> {
  try {
    const { allowed } = await requireEmploymentManager();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול תעסוקה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const id = String(fd.get("workLogId") ?? "");
    if (!isUuid(id)) return { ok: false, error: "קלט לא תקין" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_delete_work_log", { p_id: id });
    if (error) return { ok: false, error: errMessage(error.message) };
    revalidateEmployment(String(fd.get("studentId") ?? ""));
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// ---------------------------------------------------------- school year ----

/**
 * Set/clear a student's canonical school year.
 * leadership / super_admin ONLY (the coordinator sees the "שנה לא הוגדרה"
 * report but cannot change years) — enforced here AND inside the RPC.
 * View-As: blocked.
 */
export async function setStudentSchoolYearAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<EmploymentMutationResult> {
  try {
    const me = await requireMe();
    const allowed =
      me.staffId !== null && (hasRole(me, "leadership") || hasRole(me, "super_admin"));
    if (!allowed) return { ok: false, error: "רק הנהלה או מנהל מערכת יכולים להגדיר שנת לימודים" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const studentId = String(fd.get("studentId") ?? "");
    if (!isUuid(studentId)) return { ok: false, error: "קלט לא תקין" };
    const raw = String(fd.get("schoolYear") ?? "");
    let year: number | null;
    if (raw === "clear") {
      year = null; // explicit clear (corrections)
    } else if (raw === "") {
      return { ok: false, error: "בחרו שנת לימודים" };
    } else {
      year = Number(raw);
    }
    if (year !== null && (!Number.isInteger(year) || year < 1 || year > 4)) {
      return { ok: false, error: "שנת לימודים לא תקינה" };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_set_student_school_year", {
      p_student_id: studentId,
      p_year: year,
    });
    if (error) {
      if (error.message.includes("Only leadership or super_admin"))
        return { ok: false, error: "רק הנהלה או מנהל מערכת יכולים להגדיר שנת לימודים" };
      if (error.message.includes("not found")) return { ok: false, error: "החניך/ה לא נמצא/ה" };
      return { ok: false, error: error.message || "הפעולה נכשלה. נסו שוב." };
    }
    revalidateEmployment(studentId);
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}
