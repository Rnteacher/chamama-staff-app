"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMe } from "@/lib/auth";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  sendMessageSchema,
  moderateMessageSchema,
  editMessageSchema,
  markMessagesReadSchema,
} from "@/lib/validation";
import { sendPushToUsers } from "@/lib/push/send";
import { assertNotViewAs } from "@/lib/view-as";

export type ActionState = { ok: true } | { ok: false; error: string };

function errorMessage(): string {
  return "אירעה שגיאה. נסו שוב.";
}

/** Is the current staff identity a mentor of this student's group? */
async function amIMentorOf(
  supabase: Awaited<ReturnType<typeof createClient>>,
  staffId: string,
  studentId: string
): Promise<boolean> {
  const { data: student } = await supabase
    .from("students")
    .select("group_id")
    .eq("id", studentId)
    .maybeSingle();
  if (!student?.group_id) return false;
  const { data: gm } = await supabase
    .from("group_mentors")
    .select("group_id")
    .eq("group_id", student.group_id)
    .eq("staff_id", staffId)
    .maybeSingle();
  return Boolean(gm);
}

/**
 * Any authorized staff member may send a message about ANY student.
 * The author is the SERVER-resolved staff identity — never a browser value.
 * Visibility flags are honored only when the author mentors the student's
 * group (otherwise silently dropped — and the DB guard would reject them).
 */
export async function sendMessageAction(
  input: z.input<typeof sendMessageSchema>
): Promise<ActionState> {
  const parsed = sendMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const { studentId, body } = parsed.data;
  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: errorMessage() };
  const supabase = await createClient();

  let isGeneralVisible = parsed.data.isGeneralVisible;
  let isHiddenFromLeads = parsed.data.isHiddenFromLeads;
  if (isGeneralVisible || isHiddenFromLeads) {
    const mentor = await amIMentorOf(supabase, me.staffId, studentId);
    if (!mentor) {
      isGeneralVisible = false;
      isHiddenFromLeads = false;
    }
  }

  // Pre-generate the id: INSERT ... RETURNING re-checks the SELECT policy,
  // and per product rules the author cannot read their own private message.
  // The id is still needed for notification deep links.
  const messageId = crypto.randomUUID();

  const { error } = await supabase.from("student_messages").insert({
    id: messageId,
    student_id: studentId,
    author_staff_id: me.staffId,
    body,
    is_general_visible: isGeneralVisible,
    is_hidden_from_leads: isHiddenFromLeads,
  });

  if (error) {
    return { ok: false, error: errorMessage() };
  }

  revalidatePath(`/students/${studentId}`);
  revalidatePath("/updates");
  revalidatePath("/");

  await notifyRecipients(messageId, studentId).catch(() => undefined);

  return { ok: true };
}

/**
 * Notification routing: mentors of the group, assigned masters, relevant
 * major heads and privileged global roles — never the author, and filtered
 * through the same read-permission function RLS uses (get_message_recipients).
 */
async function notifyRecipients(
  messageId: string,
  studentId: string
): Promise<void> {
  const admin = createAdminClient(); // may throw — caller catches
  const { data: recipientRows } = await admin.rpc("get_message_recipients", {
    p_message_id: messageId,
  });
  const staffIds = (
    (recipientRows ?? []) as Array<{ staff_id: string }>
  ).map((r) => r.staff_id);
  if (staffIds.length === 0) return;

  const [{ data: student }, { data: settingRows }] = await Promise.all([
    admin
      .from("students")
      .select("first_name")
      .eq("id", studentId)
      .maybeSingle(),
    admin
      .from("app_settings")
      .select("value")
      .eq("key", "include_student_name_in_push")
      .maybeSingle(),
  ]);

  const includeName = settingRows?.value === true;
  const body = includeName && student?.first_name
    ? `התקבל עדכון חדש על ${student.first_name}`
    : "התקבל עדכון חדש על חניך";

  await sendPushToUsers(staffIds, {
    title: "חממה – עדכון חדש",
    body,
    url: `/students/${studentId}?m=${messageId}`,
    tag: `student-${studentId}`,
  });
}

/** Mentor-only moderation (group mentor of the message's student). */
export async function moderateMessageAction(
  input: z.input<typeof moderateMessageSchema>
): Promise<ActionState> {
  const parsed = moderateMessageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
  const { messageId, isGeneralVisible, isHiddenFromLeads } = parsed.data;

  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: errorMessage() };
  const supabase = await createClient();

  const { data: msg } = await supabase
    .from("student_messages")
    .select("student_id")
    .eq("id", messageId)
    .maybeSingle();
  if (!msg) return { ok: false, error: "ההודעה לא נמצאה" };

  const mentor = await amIMentorOf(supabase, me.staffId, msg.student_id);
  if (!mentor) {
    return { ok: false, error: "רק מנטור הקבוצה רשאי לשנות נראות" };
  }

  const { error } = await supabase
    .from("student_messages")
    .update({
      is_general_visible: isGeneralVisible,
      is_hidden_from_leads: isHiddenFromLeads,
    })
    .eq("id", messageId);

  if (error) return { ok: false, error: errorMessage() };

  revalidatePath(`/students/${msg.student_id}`);
  revalidatePath("/updates");
  return { ok: true };
}

/** Author-only body edit. */
export async function editMessageAction(
  input: z.input<typeof editMessageSchema>
): Promise<ActionState> {
  const parsed = editMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: errorMessage() };
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  const supabase = await createClient();

  const { data: msg } = await supabase
    .from("student_messages")
    .select("student_id, author_staff_id")
    .eq("id", parsed.data.messageId)
    .maybeSingle();
  if (!msg) return { ok: false, error: "ההודעה לא נמצאה" };
  if (msg.author_staff_id !== me.staffId) {
    return { ok: false, error: "רק מחבר ההודעה רשאי לערוך אותה" };
  }

  const { error } = await supabase
    .from("student_messages")
    .update({ body: parsed.data.body })
    .eq("id", parsed.data.messageId);
  if (error) return { ok: false, error: errorMessage() };

  revalidatePath(`/students/${msg.student_id}`);
  revalidatePath("/updates");
  revalidatePath("/");
  return { ok: true };
}

/** Mark specific messages as read (per-staff rows; RLS-bound to self). */
export async function markMessagesReadAction(
  input: z.input<typeof markMessagesReadSchema>
): Promise<ActionState> {
  const parsed = markMessagesReadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: errorMessage() };
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  const supabase = await createClient();

  const rows = parsed.data.messageIds.map((messageId) => ({
    staff_id: me.staffId,
    message_id: messageId,
  }));
  if (rows.length === 0) return { ok: true };

  const { error } = await supabase
    .from("message_reads")
    .upsert(rows, {
      onConflict: "staff_id,message_id",
      ignoreDuplicates: true,
    });
  if (error) return { ok: false, error: errorMessage() };

  revalidatePath("/updates");
  revalidatePath("/");
  return { ok: true };
}

/** Mark specific messages as unread (delete own read rows). */
export async function markMessagesUnreadAction(
  input: z.input<typeof markMessagesReadSchema>
): Promise<ActionState> {
  const parsed = markMessagesReadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: errorMessage() };
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  const supabase = await createClient();

  const { error } = await supabase
    .from("message_reads")
    .delete()
    .eq("staff_id", me.staffId)
    .in("message_id", parsed.data.messageIds);
  if (error) return { ok: false, error: errorMessage() };

  revalidatePath("/updates");
  revalidatePath("/");
  return { ok: true };
}

/** Mark every message currently visible to me on this student as read. */
export async function markStudentAllReadAction(
  studentId: string
): Promise<ActionState> {
  if (!/^[0-9a-f-]{36}$/i.test(studentId)) {
    return { ok: false, error: "קלט לא תקין" };
  }
  await requireMe(); // auth enforcement
  const supabase = await createClient();

  const { data: messages } = await supabase
    .from("student_messages")
    .select("id")
    .eq("student_id", studentId);
  const ids = (messages ?? []).map((m) => m.id);
  if (ids.length === 0) return { ok: true };

  return markMessagesReadAction({ messageIds: ids });
}

/** Soft-delete a student message (author or super_admin via DB RPC). */
export async function deleteMessageAction(
  messageId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireMe();
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) {
    return { ok: false, error: "קלט לא תקין" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_student_message", {
    p_message_id: messageId,
  });
  if (error) {
    if (error.message.includes("not yours"))
      return { ok: false, error: "רק מחבר ההודעה רשאי למחוק אותה" };
    return { ok: false, error: "המחיקה נכשלה" };
  }
  // refresh every surface that lists student messages
  const admin = createAdminClient();
  const { data: msg } = await admin
    .from("student_messages")
    .select("student_id")
    .eq("id", messageId)
    .maybeSingle();
  revalidatePath("/");
  revalidatePath("/updates");
  if (msg?.student_id) revalidatePath(`/students/${msg.student_id}`);
  return { ok: true };
}
