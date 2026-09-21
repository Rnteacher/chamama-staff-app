"use server";

import { revalidatePath } from "next/cache";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { calendarEventSchema, isUuid } from "@/lib/validation";
import type { ActionState } from "@/lib/actions/messages";
import { assertNotViewAs } from "@/lib/view-as";
import { jerusalemParts, isValidTime } from "@/lib/meetings";
import { upcomingWeekdayDates, type ScheduleItem } from "@/lib/schedule";

/**
 * Annual calendar + unified schedule — server actions.
 *
 * Permissions (enforced here AND inside the database RPCs):
 *   * create/edit/delete events: leadership / super_admin
 *   * conflict checks: any authenticated staff (read-only RPCs)
 *   * View-As: NO mutations (assertNotViewAs before anything).
 */

export type CalendarEventUpsertResult =
  | { ok: true; id?: string }
  | { ok: false; error: string };

async function requireCalendarAdmin() {
  const me = await requireMe();
  const allowed =
    me.staffId !== null && (hasRole(me, "leadership") || hasRole(me, "super_admin"));
  return { me, allowed };
}

export async function upsertCalendarEventAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<CalendarEventUpsertResult> {
  try {
    const { allowed } = await requireCalendarAdmin();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול לוח השנה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const id = String(fd.get("id") ?? "");
    const audiences = String(fd.get("audiences") ?? "[]");
    let parsedAudiences: unknown;
    try {
      parsedAudiences = JSON.parse(audiences);
    } catch {
      return { ok: false, error: "קהלי יעד לא תקינים" };
    }

    const parsed = calendarEventSchema.safeParse({
      id: id || undefined,
      title: String(fd.get("title") ?? ""),
      description: String(fd.get("description") ?? ""),
      startDate: String(fd.get("startDate") ?? ""),
      startTime: String(fd.get("startTime") ?? ""),
      endDate: String(fd.get("endDate") ?? ""),
      endTime: String(fd.get("endTime") ?? ""),
      isAllDay: fd.get("isAllDay") === "on" || fd.get("isAllDay") === "true",
      recurrence: String(fd.get("recurrence") ?? "none"),
      recurrenceUntil: String(fd.get("recurrenceUntil") ?? ""),
      audiences: parsedAudiences,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const e = parsed.data;

    // authorization + full validation + audit happen INSIDE the RPC
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_upsert_calendar_event", {
      p_id: e.id ?? null,
      p_title: e.title,
      p_description: e.description || null,
      p_start_date: e.startDate,
      p_start_time: e.isAllDay ? "00:00" : `${e.startTime}:00`,
      p_end_date: e.endDate,
      p_end_time: e.isAllDay ? "23:59" : `${e.endTime}:00`,
      p_is_all_day: e.isAllDay,
      p_recurrence: e.recurrence,
      p_recurrence_until: e.recurrence === "none" ? null : e.recurrenceUntil,
      p_audiences: e.audiences.map((a) => ({
        type: a.type,
        greenhouse_group_id: a.greenhouseGroupId ?? null,
        major_id: a.majorId ?? null,
        learning_group_id: a.learningGroupId ?? null,
        staff_id: a.staffId ?? null,
      })),
    });
    if (error) {
      if (error.message.includes("Only leadership or super_admin"))
        return { ok: false, error: "אין הרשאה לניהול לוח השנה" };
      return { ok: false, error: error.message || "השמירה נכשלה. נסו שוב." };
    }
    const res = (data ?? {}) as { id?: string };

    revalidatePath("/calendar");
    revalidatePath("/");
    return { ok: true, id: res.id };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function deleteCalendarEventAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    const { allowed } = await requireCalendarAdmin();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול לוח השנה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const id = String(fd.get("id") ?? "");
    if (!isUuid(id)) return { ok: false, error: "קלט לא תקין" };

    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_delete_calendar_event", {
      p_event_id: id,
    });
    if (error) {
      if (error.message.includes("Only leadership or super_admin"))
        return { ok: false, error: "אין הרשאה לניהול לוח השנה" };
      if (error.message.includes("not found"))
        return { ok: false, error: "האירוע לא נמצא" };
      return { ok: false, error: "המחיקה נכשלה. נסו שוב." };
    }

    revalidatePath("/calendar");
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// ------------------------------------------------------- conflict checks ---

export interface MeetingConflictsResult {
  ok: boolean;
  conflicts: {
    conflictDate: string;
    sourceType: "calendar_event" | "learning_group" | "meeting" | "employment";
    title: string;
    description: string;
  }[];
}

interface ConflictRow {
  conflict_date: string;
  source_type: "calendar_event" | "learning_group" | "meeting" | "employment";
  title: string;
  description: string;
}

/**
 * Server-backed conflict check for scheduling a recurring weekly meeting:
 * the concrete dates of the next `weeks` occurrences are computed here
 * (Asia/Jerusalem wall dates, DST-safe) and checked against the student's
 * canonical schedule. Never trusted from the browser.
 */
export async function checkWeeklyMeetingConflictsAction(input: {
  studentId: string;
  weekday: number;
  time: string; // HH:MM
  weeks?: number;
}): Promise<MeetingConflictsResult> {
  try {
    await requireMe();
    const { studentId, weekday, time, weeks = 8 } = input;
    if (!isUuid(studentId) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, conflicts: [] };
    }
    if (!isValidTime(time)) return { ok: false, conflicts: [] };

    const p = jerusalemParts(new Date());
    const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const dates = upcomingWeekdayDates(today, weekday, Math.min(Math.max(weeks, 1), 12));

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("check_student_meeting_conflicts", {
      p_student_id: studentId,
      p_dates: dates,
      p_start_time: `${time}:00`,
      p_duration_minutes: 60,
    });
    if (error) return { ok: false, conflicts: [] };
    const rows = (data ?? []) as unknown as ConflictRow[];
    return {
      ok: true,
      conflicts: rows.map((r) => ({
        conflictDate: String(r.conflict_date).slice(0, 10),
        sourceType: r.source_type,
        title: r.title,
        description: r.description,
      })),
    };
  } catch {
    return { ok: false, conflicts: [] };
  }
}

/**
 * Server-backed conflict check for a concrete meeting/reschedule instant
 * (Jerusalem wall date + time). Used by the reschedule flow.
 */
export async function checkMeetingConflictsAtAction(input: {
  studentId: string;
  date: string; // YYYY-MM-DD (Jerusalem)
  time: string; // HH:MM
  excludeOccurrenceId?: string | null;
}): Promise<MeetingConflictsResult> {
  try {
    await requireMe();
    const { studentId, date, time, excludeOccurrenceId } = input;
    if (!isUuid(studentId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValidTime(time)) {
      return { ok: false, conflicts: [] };
    }
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("check_student_meeting_conflicts", {
      p_student_id: studentId,
      p_dates: [date],
      p_start_time: `${time}:00`,
      p_duration_minutes: 60,
      p_exclude_occurrence_id:
        excludeOccurrenceId && isUuid(excludeOccurrenceId) ? excludeOccurrenceId : null,
    });
    if (error) return { ok: false, conflicts: [] };
    const rows = (data ?? []) as unknown as ConflictRow[];
    return {
      ok: true,
      conflicts: rows.map((r) => ({
        conflictDate: String(r.conflict_date).slice(0, 10),
        sourceType: r.source_type,
        title: r.title,
        description: r.description,
      })),
    };
  } catch {
    return { ok: false, conflicts: [] };
  }
}

/** Shape used by the unified schedule UI layers. */
export type { ScheduleItem };
