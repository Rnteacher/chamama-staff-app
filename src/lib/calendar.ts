import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScheduleItem } from "@/lib/schedule";

/**
 * Server-side fetchers for the annual calendar + unified daily schedule.
 * All occurrence expansion / audience resolution / aggregation happens in the
 * canonical SQL RPCs — these helpers only adapt rows for the UI.
 */

export interface CalendarOccurrence {
  eventId: string;
  title: string;
  description: string | null;
  isAllDay: boolean;
  recurrence: "none" | "weekly" | "monthly";
  occurrenceStart: string; // ISO
  occurrenceEnd: string; // ISO
  audienceLabels: string[];
}

/** Defensive parse: some deployments may deliver the jsonb scalar as text. */
function parseMaybeStringData(data: unknown): unknown {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

/** Expanded occurrences in [from, to] — ONE call for the whole school year. */
export async function fetchCalendarRange(
  supabase: SupabaseClient,
  from: string, // YYYY-MM-DD
  to: string // YYYY-MM-DD
): Promise<CalendarOccurrence[]> {
  const { data, error } = await supabase.rpc("calendar_events_in_range", {
    p_from: from,
    p_to: to,
  });
  if (error) {
    console.error("[calendar] calendar_events_in_range failed:", error.message);
    return [];
  }
  const rows = parseMaybeStringData(data);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const row = r as {
      event_id: string;
      title: string;
      description: string | null;
      is_all_day: boolean;
      recurrence: "none" | "weekly" | "monthly";
      occurrence_start: string;
      occurrence_end: string;
      audience_labels: string[] | null;
    };
    return {
      eventId: row.event_id,
      title: row.title,
      description: row.description,
      isAllDay: row.is_all_day,
      recurrence: row.recurrence,
      occurrenceStart: row.occurrence_start,
      occurrenceEnd: row.occurrence_end,
      audienceLabels: row.audience_labels ?? [],
    };
  });
}

function toScheduleItem(r: {
  source_type: string;
  source_id: string;
  title: string;
  start_at: string;
  end_at: string;
  is_all_day: boolean;
  context: string | null;
  link_path: string | null;
}): ScheduleItem {
  return {
    sourceType: r.source_type as ScheduleItem["sourceType"],
    sourceId: r.source_id,
    title: r.title,
    startAt: r.start_at,
    endAt: r.end_at,
    isAllDay: r.is_all_day,
    context: r.context,
    linkPath: r.link_path,
  };
}

/** The staff member's unified day (events + meetings + led learning groups). */
export async function fetchStaffDay(
  supabase: SupabaseClient,
  staffId: string,
  date: string // YYYY-MM-DD
): Promise<ScheduleItem[]> {
  const { data, error } = await supabase.rpc("staff_day_schedule", {
    p_staff_id: staffId,
    p_date: date,
  });
  if (error) {
    console.error("[calendar] staff_day_schedule failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Parameters<typeof toScheduleItem>[0][]).map(
    toScheduleItem
  );
}

/** A student's unified day (events + meetings + learning groups). */
export async function fetchStudentDay(
  supabase: SupabaseClient,
  studentId: string,
  date: string
): Promise<ScheduleItem[]> {
  const { data, error } = await supabase.rpc("student_day_schedule", {
    p_student_id: studentId,
    p_date: date,
  });
  if (error) {
    console.error("[calendar] student_day_schedule failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Parameters<typeof toScheduleItem>[0][]).map(
    toScheduleItem
  );
}
