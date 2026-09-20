"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { assertNotViewAs } from "@/lib/view-as";

export async function deleteMeetingReportAction(
  reportId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireMe();
  if (!(await assertNotViewAs())) {
    return { ok: false, error: "לא זמין במצב צפייה" };
  }
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) {
    return { ok: false, error: "קלט לא תקין" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_meeting_report", {
    p_report_id: reportId,
  });
  if (error) {
    if (error.message.includes("Only the reporter")) return { ok: false, error: "רק מחבר הדוח או מנהל מערכת רשאי למחוק" };
    return { ok: false, error: "המחיקה נכשלה" };
  }
  revalidatePath("/");
  return { ok: true };
}
