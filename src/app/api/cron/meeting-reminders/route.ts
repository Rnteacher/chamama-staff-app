import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push/send";
import { schoolWeekStart, meetingDeepLink } from "@/lib/meetings";
import { verifyCronAuth } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

/**
 * Due-meeting reminder dispatcher.
 *
 * Trigger: Supabase Cron (pg_cron + pg_net) every 5 minutes →
 *   GET /api/cron/meeting-reminders  with  Authorization: Bearer <CRON_SECRET>
 * (Vercel Hobby does not allow sub-daily Vercel Cron; the endpoint itself is
 * unchanged — see docs/MEETING-REMINDER-CRON.md)
 *
 * 1. generates missing occurrences for the current + next school week
 *    (Asia/Jerusalem, Sunday-based) - idempotent via unique(schedule, week)
 * 2. ATOMICALLY claims due, un-notified occurrences via
 *    claim_due_meeting_occurrences() (FOR UPDATE SKIP LOCKED + lease):
 *    two concurrent dispatcher runs can never own the same occurrence
 * 3. sends one privacy-preserving reminder per claimed occurrence
 *    (deep link: /students/<id>?meeting=<occ>&report=1)
 * 4. marks notified_at on success; clears the claim on retryable failure
 *    (crashed workers' claims expire after the 60s lease and are retried)
 */
export async function GET(request: Request) {
  const auth = verifyCronAuth(request, process.env.CRON_SECRET);
  if (!auth.ok) {
    return NextResponse.json(
      auth.status === 500
        ? { error: "CRON_SECRET is not configured" }
        : { error: "unauthorized" },
      { status: auth.status }
    );
  }

  const admin = createAdminClient();

  // 1) occurrences for this week and next week
  const thisWeek = schoolWeekStart(new Date());
  const nextWeekDate = new Date();
  nextWeekDate.setUTCDate(nextWeekDate.getUTCDate() + 7);
  const nextWeek = schoolWeekStart(nextWeekDate);

  for (const week of [thisWeek, nextWeek]) {
    const { error } = await admin.rpc("scheduler_generate_occurrences", {
      p_week_start: week,
    });
    if (error) {
      return NextResponse.json(
        { error: "occurrence generation failed", detail: error.message },
        { status: 500 }
      );
    }
  }

  // 2) atomic claim — only claimed rows are sent by this dispatcher
  const { data: claimed, error: claimError } = await admin.rpc(
    "claim_due_meeting_occurrences",
    { p_limit: 50 }
  );
  if (claimError) {
    return NextResponse.json(
      { error: "claim failed", detail: claimError.message },
      { status: 500 }
    );
  }

  const rows = (claimed ?? []) as Array<{
    occurrence_id: string;
    student_id: string;
    staff_id: string;
    first_name: string | null;
  }>;

  // 3) one privacy-preserving reminder per claimed occurrence
  //    (each occurrence deep-links to its own student page)
  const { data: setting } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "include_student_name_in_push")
    .maybeSingle();
  const includeName = setting?.value === true;

  let sent = 0;
  for (const row of rows) {
    const delivery = await sendPushToUsers([row.staff_id], {
      title: "חממה – תזכורת פגישה",
      body:
        includeName && row.first_name
          ? `מתקרבת הפגישה השבועית עם ${row.first_name}`
          : "מתקרבת הפגישה השבועית המתוכננת",
      url: meetingDeepLink(row.student_id, row.occurrence_id),
      tag: `meeting-${row.occurrence_id}`,
    });

    if (delivery[row.staff_id] !== false) {
      // done (delivered / no subscriptions / only pruned devices):
      // mark notified so this occurrence is never sent again
      sent += 1;
      const { error: markError } = await admin
        .from("meeting_occurrences")
        .update({
          notified_at: new Date().toISOString(),
          notify_started_at: null,
        })
        .eq("id", row.occurrence_id);
      if (markError) {
        // claim lease expires (60s) — worst case: one duplicate reminder
        await admin.from("audit_logs").insert({
          action: "meeting_reminder_mark_failed",
          entity_type: "meeting_occurrence",
          entity_id: row.occurrence_id,
          metadata: { detail: markError.message },
        });
      }
    } else {
      // retryable failure — release the claim immediately
      await admin
        .from("meeting_occurrences")
        .update({ notify_started_at: null })
        .eq("id", row.occurrence_id);
    }
  }

  return NextResponse.json({
    ok: true,
    generated_for: [thisWeek, nextWeek],
    claimed: rows.length,
    reminders_sent: sent,
  });
}
