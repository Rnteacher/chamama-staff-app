"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isValidTime, schoolWeekStart, jerusalemWallTimeToUtc } from "@/lib/meetings";
import { assertNotViewAs } from "@/lib/view-as";

const ADHOC_SCHEMA = z.object({
  studentId: z.string().uuid(),
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
  studentId: z.string().uuid(),
  context: z.enum(["mentor", "master"]),
  weekday: z.coerce.number().int().min(0).max(6),
  meetingTime: z.string().refine(isValidTime, "שעה לא תקינה"),
  isActive: z.boolean(),
  scheduleId: z.string().uuid().nullable().optional(),
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
  occurrenceId: z.string().uuid(),
  held: z.boolean(),
  notHeldReason: z.string().trim().max(500).optional().or(z.literal("")),
  /** Jerusalem wall time from datetime-local; converted to UTC here */
  rescheduleLocal: z.string().optional().or(z.literal("")),
  status: z.enum(["green", "yellow", "red"]),
  intervention: z.boolean(),
  categories: z.array(z.enum(["functional", "emotional", "other"])),
  detailFunctional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailEmotional: z.string().trim().max(1000).optional().or(z.literal("")),
  detailOther: z.string().trim().max(1000).optional().or(z.literal("")),
  nextSteps: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function submitMeetingReportAction(
  input: z.input<typeof reportSchema>
): Promise<{ ok: true } | { ok: false; error: string }> {
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
