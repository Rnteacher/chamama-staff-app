"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { assertNotViewAs } from "@/lib/view-as";
import type { ActionState } from "@/lib/actions/messages";

async function requireCoordinator() {
  const me = await requireMe();
  if (!me.staffId || (!hasRole(me, "super_admin") && !hasRole(me, "project_coordinator"))) {
    redirect("/");
  }
  return { me, allowed: true };
}

export async function formCreateAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("form_create", {
      p_form_key: String(fd.get("formKey") ?? "").trim(),
      p_name: String(fd.get("name") ?? "").trim(),
      p_description: String(fd.get("description") ?? "").trim() || null,
      p_audience: String(fd.get("audience") ?? "staff"),
      p_feed_category: String(fd.get("feedCategory") ?? "hidden"),
      p_draft_schema: JSON.parse(String(fd.get("schema") ?? "{}")),
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/admin/forms");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה" };
  }
}

export async function formSaveDraftAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("form_save_draft", {
      p_form_id: String(fd.get("formId") ?? ""),
      p_name: String(fd.get("name") ?? "").trim() || null,
      p_description: String(fd.get("description") ?? "").trim() || null,
      p_feed_category: String(fd.get("feedCategory") ?? "").trim() || null,
      p_draft_schema: JSON.parse(String(fd.get("schema") ?? "{}")),
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/admin/forms/${fd.get("formId")}`);
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה" };
  }
}

export async function formPublishAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("form_publish", {
      p_form_id: String(fd.get("formId") ?? ""),
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/admin/forms");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפרסום נכשל" };
  }
}

export async function formArchiveAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("form_archive", {
      p_form_id: String(fd.get("formId") ?? ""),
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/admin/forms");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הארכוב נכשלה" };
  }
}

export async function formDeleteDraftAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("form_delete_draft", {
      p_form_id: String(fd.get("formId") ?? ""),
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/admin/forms");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "המחיקה נכשלה" };
  }
}

export async function formDuplicateAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const newKey = String(fd.get("newKey") ?? "").trim();
    const newName = String(fd.get("newName") ?? "").trim();
    const { error } = await supabase.rpc("form_create", {
      p_form_key: newKey,
      p_name: newName,
      p_description: null,
      p_audience: "staff",
      p_feed_category: "hidden",
      p_draft_schema: JSON.parse(String(fd.get("schema") ?? "{}")),
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/admin/forms");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "השכפול נכשל" };
  }
}

export async function formCampaignCreateAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState & { token?: string }> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const { data: token, error } = await supabase.rpc("form_campaign_create", {
      p_form_id: String(fd.get("formId") ?? ""),
      p_opens_at: new Date(String(fd.get("opensAt") ?? "")).toISOString(),
      p_closes_at: new Date(String(fd.get("closesAt") ?? "")).toISOString(),
      p_subject_student_id: String(fd.get("subjectStudentId") ?? "") || null,
      p_allow_resubmit: fd.get("allowResubmit") === "true",
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/admin/forms");
    return { ok: true, token: token as string };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "יצירת הקישור נכשלה" };
  }
}

export async function formCampaignRevokeAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireCoordinator();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("form_campaign_revoke", {
      p_campaign_id: String(fd.get("campaignId") ?? ""),
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/admin/forms");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "ההשבתה נכשלה" };
  }
}
