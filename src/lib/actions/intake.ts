"use server";

import { revalidatePath } from "next/cache";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { requireMe, hasRole } from "@/lib/auth";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/actions/messages";

export type IntakeCreateResult =
  | { ok: true; token?: string }
  | { ok: false; error: string };

/** project coordinator OR super_admin (never email-based) */
export async function requireCoordinator() {
  const me = await requireMe();
  const allowed =
    me.staffId !== null &&
    (hasRole(me, "project_coordinator") || hasRole(me, "super_admin"));
  return { me, allowed };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const windowSchema = z
  .object({
    title: z.string().trim().min(1, "חסרה כותרת").max(120),
    opensAt: z.string().min(1, "חסר זמן פתיחה"),
    closesAt: z.string().min(1, "חסר זמן סגירה"),
  })
  .refine((v) => new Date(v.opensAt) < new Date(v.closesAt), {
    message: "שעת הפתיחה חייבת להיות לפני שעת הסגירה",
    path: ["closesAt"],
  });

export async function createIntakeWindowAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<IntakeCreateResult> {
  try {
    const { me, allowed } = await requireCoordinator();
    if (!allowed) return { ok: false, error: "אין הרשאה ליצירת טפסי קבלה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };

    const parsed = windowSchema.safeParse({
      title: String(fd.get("title") ?? "").trim(),
      opensAt: String(fd.get("opensAt") ?? ""),
      closesAt: String(fd.get("closesAt") ?? ""),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }

    // cryptographically unguessable public token; only its SHA-256 is stored
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);

    const admin = createAdminClient();
    const { error } = await admin.from("intake_windows").insert({
      title: parsed.data.title,
      token_hash: tokenHash,
      opens_at: new Date(parsed.data.opensAt).toISOString(),
      closes_at: new Date(parsed.data.closesAt).toISOString(),
      created_by_staff_id: me.staffId,
    });
    if (error) return { ok: false, error: "יצירת הטופס נכשלה" };

    const admin2 = createAdminClient();
    await admin2.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "intake_window_create",
      entity_type: "intake_window",
      entity_id: null,
      metadata: { title: parsed.data.title, opens_at: parsed.data.opensAt, closes_at: parsed.data.closesAt },
    });

    revalidatePath("/admin/intake");
    return { ok: true, token };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function revokeIntakeWindowAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    const { me, allowed } = await requireCoordinator();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
    const id = String(fd.get("id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "קלט לא תקין" };

    const admin = createAdminClient();
    const { error } = await admin
      .from("intake_windows")
      .update({ is_revoked: true, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false, error: "השבתת הטופס נכשלה" };

    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "intake_window_revoke",
      entity_type: "intake_window",
      entity_id: id,
      metadata: {},
    });

    revalidatePath("/admin/intake");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function assignMasterFromIntakeAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    const { allowed } = await requireCoordinator();
    if (!allowed) return { ok: false, error: "אין הרשאה לשיבוץ מאסטר/ית" };

    const submissionId = String(fd.get("submissionId") ?? "");
    const masterStaffId = String(fd.get("masterStaffId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(submissionId) || !/^[0-9a-f-]{36}$/i.test(masterStaffId)) {
      return { ok: false, error: "קלט לא תקין" };
    }

    // transactional RPC; authorization + active-staff validation inside
    const supabase = await createClient();
    const { error } = await supabase.rpc("coordinator_set_master", {
      p_submission_id: submissionId,
      p_master_staff_id: masterStaffId,
    });
    if (error) {
      if (error.message.includes("Only a project coordinator"))
        return { ok: false, error: "אין הרשאה לשיבוץ מאסטר/ית" };
      if (error.message.includes("active staff"))
        return { ok: false, error: "המאסטר/ית שנבחר/ה אינו/ה פעיל/ה" };
      return { ok: false, error: "השיבוץ נכשל. נסו שוב." };
    }

    revalidatePath("/admin/intake");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}
