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

// ============================================================ CSV IMPORT ====

import {
  parseCalendarCsv,
  type AudienceToken,
  type CalendarCsvRow,
} from "@/lib/calendar-csv";

export interface CalendarCsvPreviewRow {
  line: number;
  title: string;
  valid: boolean;
  errors: string[];
  audiencesPreview: string[];
  startDate: string;
  endDate: string;
  isAllDay: boolean;
  recurrence: string;
}

export interface CalendarCsvPreview {
  ok: boolean;
  error?: string;
  rows?: CalendarCsvPreviewRow[];
  validCount?: number;
  invalidCount?: number;
}

type ResolvedAudience = {
  type: "everyone" | "staff_only" | "home_group" | "major" | "learning_group" | "staff_member";
  greenhouse_group_id?: string;
  major_id?: string;
  learning_group_id?: string;
  staff_id?: string;
};

const TYPE_LABELS: Record<ResolvedAudience["type"], string> = {
  everyone: "כולם",
  staff_only: "צוות בלבד",
  home_group: "קבוצה",
  major: "מגמה",
  learning_group: "קבוצת למידה",
  staff_member: "איש צוות",
};

/**
 * Server-side NAME→ID audience resolution. Exact matches only; an unprefixed
 * target is tried across types and must be UNAMBIGUOUS — ambiguous/unknown
 * targets become row errors, never guesses.
 */
async function resolveAudienceTokens(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tokens: AudienceToken[]
): Promise<{ audiences: ResolvedAudience[]; errors: string[] }> {
  const [groupsRes, majorsRes, lgsRes, staffRes] = await Promise.all([
    supabase.from("greenhouse_groups").select("id, name"),
    supabase.from("majors").select("id, name"),
    supabase.from("learning_groups").select("id, name"),
    supabase.from("profiles").select("id, email, full_name").eq("is_active", true),
  ]);
  const groups = (groupsRes.data ?? []) as { id: string; name: string }[];
  const majors = (majorsRes.data ?? []) as { id: string; name: string }[];
  const lgs = (lgsRes.data ?? []) as { id: string; name: string }[];
  const staff = (staffRes.data ?? []) as { id: string; email: string; full_name: string | null }[];

  const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  const resolveOne = (token: AudienceToken): ResolvedAudience[] => {
    switch (token.kind) {
      case "everyone":
        return [{ type: "everyone" }];
      case "staff_only":
        return [{ type: "staff_only" }];
      case "home_group":
        return groups
          .filter((g) => eq(g.name, token.target))
          .map((g) => ({ type: "home_group" as const, greenhouse_group_id: g.id }));
      case "major":
        return majors
          .filter((m) => eq(m.name, token.target))
          .map((m) => ({ type: "major" as const, major_id: m.id }));
      case "learning_group":
        return lgs
          .filter((l) => eq(l.name, token.target))
          .map((l) => ({ type: "learning_group" as const, learning_group_id: l.id }));
      case "staff_member":
        return staff
          .filter((p) => eq(p.email, token.target) || eq(p.full_name ?? "", token.target))
          .map((p) => ({ type: "staff_member" as const, staff_id: p.id }));
      case "auto": {
        const matches: ResolvedAudience[] = [
          ...groups
            .filter((g) => eq(g.name, token.target))
            .map((g) => ({ type: "home_group" as const, greenhouse_group_id: g.id })),
          ...majors
            .filter((m) => eq(m.name, token.target))
            .map((m) => ({ type: "major" as const, major_id: m.id })),
          ...lgs
            .filter((l) => eq(l.name, token.target))
            .map((l) => ({ type: "learning_group" as const, learning_group_id: l.id })),
          ...staff
            .filter((p) => eq(p.email, token.target) || eq(p.full_name ?? "", token.target))
            .map((p) => ({ type: "staff_member" as const, staff_id: p.id })),
        ];
        // de-duplicate identical resolutions
        const seen = new Set<string>();
        return matches.filter((m) => {
          const key = JSON.stringify(m);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    }
  };

  const audiences: ResolvedAudience[] = [];
  const errors: string[] = [];
  for (const token of tokens) {
    const matches = resolveOne(token);
    if (matches.length === 0) {
      errors.push(`קהל יעד לא מזוהה: "${token.target}"`);
    } else if (matches.length > 1) {
      errors.push(`קהל יעד לא חד-משמעי: "${token.target}" — נמצאו ${matches.length} התאמות`);
    } else {
      audiences.push(matches[0]);
    }
  }
  return { audiences, errors };
}

async function buildImportPayload(
  supabase: Awaited<ReturnType<typeof createClient>>,
  csvText: string
): Promise<
  | { ok: true; payload: Record<string, unknown>[]; preview: CalendarCsvPreviewRow[] }
  | { ok: false; preview: CalendarCsvPreviewRow[]; error: string }
> {
  const parsed = parseCalendarCsv(csvText);
  if (parsed.fatal) {
    return { ok: false, preview: [], error: parsed.fatal };
  }
  const preview: CalendarCsvPreviewRow[] = [];
  const payload: Record<string, unknown>[] = [];
  let invalidCount = 0;

  for (const row of parsed.rows) {
    const errors = [...row.errors];
    let audiences: ResolvedAudience[] = [];
    if (errors.length === 0) {
      const resolved = await resolveAudienceTokens(supabase, row.audiences);
      errors.push(...resolved.errors);
      audiences = resolved.audiences;
    }
    const audiencesPreview = row.audiences.map((t) => t.target);
    const valid = errors.length === 0;
    if (!valid) invalidCount += 1;
    preview.push({
      line: row.line,
      title: row.title,
      valid,
      errors,
      audiencesPreview,
      startDate: row.startDate,
      endDate: row.endDate,
      isAllDay: row.isAllDay,
      recurrence: row.recurrence,
    });
    if (valid) {
      payload.push({
        title: row.title,
        description: row.description || null,
        start_date: row.startDate,
        start_time: row.isAllDay ? "00:00" : `${row.startTime}:00`,
        end_date: row.endDate,
        end_time: row.isAllDay ? "23:59" : `${row.endTime}:00`,
        is_all_day: row.isAllDay,
        recurrence: row.recurrence,
        recurrence_until: row.recurrence === "none" ? null : row.recurrenceUntil,
        audiences,
      });
    }
  }
  return { ok: true, payload, preview };
}

function csvPreview(rows: CalendarCsvPreviewRow[], extraError?: string): CalendarCsvPreview {
  const validCount = rows.filter((r) => r.valid).length;
  return {
    ok: true,
    rows,
    validCount,
    invalidCount: rows.length - validCount,
    ...(extraError ? { error: extraError } : {}),
  };
}

/** Preview: parse + resolve + validate. NO writes. */
export async function previewCalendarCsvImportAction(
  _prev: CalendarCsvPreview | null,
  fd: FormData
): Promise<CalendarCsvPreview> {
  try {
    const me = await requireMe();
    if (!(hasRole(me, "leadership") || hasRole(me, "super_admin"))) {
      return { ok: false, error: "אין הרשאה לניהול לוח השנה" };
    }
    const file = fd.get("file");
    let text = typeof fd.get("text") === "string" ? String(fd.get("text")) : "";
    if (file instanceof File && file.size > 0) {
      if (file.size > 256 * 1024) return { ok: false, error: "הקובץ גדול מדי (מוגבל ל־256KB)" };
      text = await file.text();
    }
    if (text.trim() === "") return { ok: false, error: "לא נבחר קובץ CSV" };
    const supabase = await createClient();
    const result = await buildImportPayload(supabase, text);
    if (!result.ok) return { ok: false, error: result.error };
    return csvPreview(result.preview);
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "קריאת הקובץ נכשלה. נסו שוב." };
  }
}

/** Confirm: re-validate EVERYTHING, then import valid rows in ONE transaction. */
export async function confirmCalendarCsvImportAction(
  _prev: CalendarCsvPreview | null,
  fd: FormData
): Promise<CalendarCsvPreview> {
  try {
    const me = await requireMe();
    if (!(hasRole(me, "leadership") || hasRole(me, "super_admin"))) {
      return { ok: false, error: "אין הרשאה לניהול לוח השנה" };
    }
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const file = fd.get("file");
    let text = typeof fd.get("text") === "string" ? String(fd.get("text")) : "";
    if (file instanceof File && file.size > 0) {
      if (file.size > 256 * 1024) return { ok: false, error: "הקובץ גדול מדי (מוגבל ל־256KB)" };
      text = await file.text();
    }
    if (text.trim() === "") return { ok: false, error: "לא נבחר קובץ CSV" };

    const supabase = await createClient();
    const result = await buildImportPayload(supabase, text);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.preview.some((r) => !r.valid)) {
      return csvPreview(result.preview, "יש שורות לא תקינות — תקנו אותן והעלו מחדש (לא בוצע ייבוא)");
    }
    if (result.payload.length === 0) {
      return { ok: false, error: "אין אירועים לייבוא" };
    }

    // canonical creation path: same RPC/validation/audit as manual creation,
    // single transaction — a failing row rolls back the whole import
    const { data, error } = await supabase.rpc("admin_import_calendar_events", {
      p_events: result.payload,
    });
    if (error) return { ok: false, error: error.message || "הייבוא נכשל. נסו שוב." };
    const res = (data ?? {}) as { imported?: number };
    revalidatePath("/calendar");
    return csvPreview(
      result.preview,
      `יובאו ${res.imported ?? result.payload.length} אירועים בהצלחה`
    );
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: "הייבוא נכשל. נסו שוב." };
  }
}
