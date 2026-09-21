"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isValidTime, schoolWeekStart, jerusalemWallTimeToUtc } from "@/lib/meetings";
import { assertNotViewAs } from "@/lib/view-as";

const updateReportSchema = z.object({
  reportId: uuidSchema,
  meetingAtLocal: z.string().min(1, "הזינו תאריך ושעה"),
  held: z.boolean(),
  notHeldReason: z.string().trim().max(500).optional().or(z.literal("")),
  status: z.enum(["green", "yellow", "red"]),
  intervention: z.boolean(),
  categories: z.array(z.enum(["functional", "emotional", "other"])),
  detailFunctional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailEmotional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailOther: z.string().trim().max(1000).optional().or(z.literal("")),
  nextSteps: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function updateMeetingReportAction(
  input: z.input<typeof updateReportSchema>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = updateReportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  await requireMe();
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  const d = parsed.data;
  const [datePart, timePart] = d.meetingAtLocal.split("T");
  if (!datePart || !timePart) return { ok: false, error: "מועד לא תקין" };
  const [y, mo, da] = datePart.split("-").map(Number);
  const [hh, mi] = timePart.split(":").map(Number);
  const meetingAtIso = jerusalemWallTimeToUtc(y, mo, da, hh, mi).toISOString();

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_meeting_report", {
    p_report_id: d.reportId,
    p_meeting_at: meetingAtIso,
    p_held: d.held,
    p_not_held_reason: d.held ? null : d.notHeldReason || null,
    p_status: d.status,
    p_intervention: d.intervention,
    p_categories: d.intervention ? d.categories : [],
    p_detail_functional: d.intervention && d.categories.includes("functional") ? d.detailFunctional || null : null,
    p_detail_emotional: d.intervention && d.categories.includes("emotional") ? d.detailEmotional || null : null,
    p_detail_other: d.intervention && d.categories.includes("other") ? d.detailOther || null : null,
    p_next_steps: d.nextSteps || null,
  });
  if (error) {
    const msg = error.message;
    if (msg.includes("Only the reporter")) return { ok: false, error: "רק מחבר הדוח רשאי לערוך אותו" };
    if (msg.includes("Invalid meeting time")) return { ok: false, error: "מועד הפגישה אינו תקין" };
    if (msg.includes("A reason is required")) return { ok: false, error: "נדרשת סיבה כשהפגישה לא התקיימה" };
    if (msg.includes("Next steps are required")) return { ok: false, error: "נדרש לרשום את מה שהוחלט" };
    if (msg.includes("Select at least one")) return { ok: false, error: "בחרו לפחות תחום התערבות אחד" };
    if (msg.includes("detail is required")) return { ok: false, error: "נדרש פירוט לכל תחום שנבחר" };
    return { ok: false, error: "העריכה נכשלה. נסו שוב." };
  }
  return { ok: true };
}

export async function deactivateMeetingScheduleAction(
  scheduleId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireMe();
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  if (!/^[0-9a-f-]{36}$/i.test(scheduleId)) {
    return { ok: false, error: "קלט לא תקין" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("deactivate_meeting_schedule", {
    p_schedule_id: scheduleId,
  });
  if (error) return { ok: false, error: "המחיקה נכשלה" };
  revalidatePath("/");
  return { ok: true };
}

const ADHOC_SCHEMA = z.object({
  studentId: uuidSchema,
  context: z.enum(["mentor", "master"]),
  meetingAtLocal: z.string().min(1, "הזינו תאריך ושעה"),
  held: z.boolean(),
  notHeldReason: z.string().trim().max(500).optional().or(z.literal("")),
  status: z.enum(["green", "yellow", "red"]),
  intervention: z.boolean(),
  categories: z.array(z.enum(["functional", "emotional", "other"])),
  detailFunctional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailEmotional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailOther: z.string().trim().max(1000).optional().or(z.literal("")),
  nextSteps: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function submitAdhocMeetingReportAction(
  input: z.input<typeof ADHOC_SCHEMA>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = ADHOC_SCHEMA.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  await requireMe();
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  const d = parsed.data;

  // interpret datetime-local as Asia/Jerusalem wall time → UTC
  const [datePart, timePart] = d.meetingAtLocal.split("T");
  if (!datePart || !timePart) return { ok: false, error: "מועד לא תקין" };
  const [y, mo, da] = datePart.split("-").map(Number);
  const [hh, mi] = timePart.split(":").map(Number);
  const meetingAtIso = jerusalemWallTimeToUtc(y, mo, da, hh, mi).toISOString();

  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_adhoc_meeting_report", {
    p_student_id: d.studentId,
    p_context: d.context,
    p_meeting_at: meetingAtIso,
    p_held: d.held,
    p_not_held_reason: d.held ? null : d.notHeldReason || null,
    p_status: d.status,
    p_intervention: d.intervention,
    p_categories: d.intervention ? d.categories : [],
    p_detail_functional: d.intervention && d.categories.includes("functional") ? d.detailFunctional || null : null,
    p_detail_emotional: d.intervention && d.categories.includes("emotional") ? d.detailEmotional || null : null,
    p_detail_other: d.intervention && d.categories.includes("other") ? d.detailOther || null : null,
    p_next_steps: d.nextSteps || null,
  });
  if (error) {
    const msg = error.message;
    if (msg.includes("Not authorized to report")) return { ok: false, error: "אין הרשאה לדווח על חניך/ה זה" };
    if (msg.includes("Invalid meeting time")) return { ok: false, error: "מועד הפגישה אינו תקין" };
    if (msg.includes("Invalid student status")) return { ok: false, error: "מצב לא תקין" };
    if (msg.includes("A reason is required")) return { ok: false, error: "נדרשת סיבה כשהפגישה לא התקיימה" };
    if (msg.includes("Next steps are required")) return { ok: false, error: "נדרש לרשום את מה שהוחלט" };
    if (msg.includes("Select at least one")) return { ok: false, error: "בחרו לפחות תחום התערבות אחד" };
    if (msg.includes("detail is required")) return { ok: false, error: "נדרש פירוט לכל תחום שנבחר" };
    return { ok: false, error: "הדיווח נכשל. נסו שוב." };
  }

  revalidatePath("/");
  return { ok: true };
}

function err(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("Only the schedule owner")) return "רק בעל/ת הפגישה רשאי/ת לדווח עליה";
  if (msg.includes("same school week")) return "מועד חדש מותר רק בתוך אותו שבוע לימודים (ראשון–שבת)";
  if (msg.includes("Invalid student status")) return "מצב לא תקין";
  if (msg.includes("A reason is required")) return "נדרשת סיבה כשהפגישה לא התקיימה";
  if (msg.includes("Next steps are required")) return "נדרש לרשום את מה שהוחלט לקראת הפגישה הבאה";
  if (msg.includes("Select at least one")) return "בחרו לפחות תחום התערבות אחד";
  if (msg.includes("detail is required")) return "נדרש פירוט לכל תחום התערבות שנבחר";
  if (msg.includes("Not authorized to schedule")) return "אין הרשאה לקבוע פגישה לחניך/ה זה";
  if (msg.includes("Schedule not found")) return "הפגישה השבועית לא נמצאה או שאינה שלכם";
  if (msg.includes("future")) return "המועד החדש חייב להיות בעתיד";
  return "הפעולה נכשלה. נסו שוב.";
}

const scheduleSchema = z.object({
  studentId: uuidSchema,
  context: z.enum(["mentor", "master"]),
  weekday: z.coerce.number().int().min(0).max(6),
  meetingTime: z.string().refine(isValidTime, "שעה לא תקינה"),
  isActive: z.boolean(),
  scheduleId: uuidSchema.nullable().optional(),
});

export async function upsertMeetingScheduleAction(
  input: z.input<typeof scheduleSchema>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  await requireMe();
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("upsert_meeting_schedule", {
    p_student_id: parsed.data.studentId,
    p_context: parsed.data.context,
    p_weekday: parsed.data.weekday,
    p_meeting_time: parsed.data.meetingTime + ":00",
    p_is_active: parsed.data.isActive,
    p_schedule_id: parsed.data.scheduleId ?? null,
  });
  if (error) return { ok: false, error: err(new Error(error.message)) };
  revalidatePath(`/students/${parsed.data.studentId}`);
  revalidatePath("/");
  return { ok: true };
}

const reportSchema = z.object({
  occurrenceId: uuidSchema,
  held: z.boolean(),
  notHeldReason: z.string().trim().max(500).optional().or(z.literal("")),
  /** Jerusalem wall time from datetime-local; converted to UTC here */
  rescheduleLocal: z.string().optional().or(z.literal("")),
  /** user acknowledged scheduling conflicts (server still verifies them) */
  overrideConflicts: z.boolean().default(false),
  status: z.enum(["green", "yellow", "red"]),
  intervention: z.boolean(),
  categories: z.array(z.enum(["functional", "emotional", "other"])),
  detailFunctional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailEmotional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailOther: z.string().trim().max(1000).optional().or(z.literal("")),
  nextSteps: z.string().trim().max(2000).optional().or(z.literal("")),
});

export interface MeetingConflictInfo {
  sourceType: "calendar_event" | "learning_group" | "meeting" | "employment";
  title: string;
  description: string;
}

export type SubmitReportResult =
  | { ok: true }
  | { ok: false; error: string }
  | {
      ok: false;
      needsOverride: true;
      conflicts: MeetingConflictInfo[];
    };

export async function submitMeetingReportAction(
  input: z.input<typeof reportSchema>
): Promise<SubmitReportResult> {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  await requireMe();
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  const supabase = await createClient();

  // client-side same-week guard (server enforces again in the RPC)
  let rescheduleIso: string | null = null;
  const d = parsed.data;
  if (!d.held && d.rescheduleLocal) {
    const [datePart, timePart] = d.rescheduleLocal.split("T");
    if (!datePart || !timePart) return { ok: false, error: "מועד חדש לא תקין" };
    const [y, mo, da] = datePart.split("-").map(Number);
    const [hh, mm] = timePart.split(":").map(Number);
    const { jerusalemWallTimeToUtc } = await import("@/lib/meetings");
    const utc = jerusalemWallTimeToUtc(y, mo, da, hh, mm);
    if (schoolWeekStart(utc) !== schoolWeekStart(new Date())) {
      return { ok: false, error: "מועד חדש מותר רק בתוך אותו שבוע לימודים (ראשון–שבת)" };
    }

    rescheduleIso = utc.toISOString();
  }

  // conflict gate (server-computed; never browser-only): the student's
  // canonical schedule vs the new slot
  if (!d.held && rescheduleIso && !d.overrideConflicts) {
    const { data: occ } = await supabase
      .from("meeting_occurrences")
      .select("id, schedule_id")
      .eq("id", d.occurrenceId)
      .maybeSingle();
    const schedId = (occ as { schedule_id: string } | null)?.schedule_id;
    const { data: sched } = schedId
      ? await supabase
          .from("meeting_schedules")
          .select("student_id")
          .eq("id", schedId)
          .maybeSingle()
      : { data: null };
    const studentId = (sched as { student_id: string } | null)?.student_id;
    if (studentId && d.rescheduleLocal) {
      const rescheduleTime = d.rescheduleLocal.split("T")[1];
      const { data: conflictRows, error: conflictError } = await supabase.rpc(
        "check_student_meeting_conflicts",
        {
          p_student_id: studentId,
          p_dates: [rescheduleIso.slice(0, 10)],
          p_start_time: `${rescheduleTime}:00`,
          p_duration_minutes: 60,
          p_exclude_occurrence_id: d.occurrenceId,
        }
      );
      if (!conflictError && Array.isArray(conflictRows) && conflictRows.length > 0) {
        return {
          ok: false,
          needsOverride: true,
          conflicts: (conflictRows as {
            source_type: MeetingConflictInfo["sourceType"];
            title: string;
            description: string;
          }[]).map((c) => ({
            sourceType: c.source_type,
            title: c.title,
            description: c.description,
          })),
        };
      }
    }
  }

  const { error } = await supabase.rpc("submit_meeting_report", {
    p_occurrence_id: d.occurrenceId,
    p_held: d.held,
    p_not_held_reason: d.held ? null : (d.notHeldReason || null),
    p_reschedule_to: rescheduleIso,
    p_status: d.status,
    p_intervention: d.intervention,
    p_categories: d.intervention ? d.categories : [],
    p_detail_functional: d.detailFunctional || null,
    p_detail_emotional: d.detailEmotional || null,
    p_detail_other: d.detailOther || null,
    p_next_steps: d.nextSteps || null,
  });
  if (error) return { ok: false, error: err(new Error(error.message)) };

  revalidatePath("/");
  return { ok: true };
}
