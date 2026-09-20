"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireMe, hasRole } from "@/lib/auth";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { hashIntakeToken } from "@/lib/intake-token";
import { encryptToken } from "@/lib/intake-crypto";
import { jerusalemWallTimeToUtc } from "@/lib/meetings";
import type { ActionState } from "@/lib/actions/messages";
import { assertNotViewAs } from "@/lib/view-as";

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
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
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
    const tokenHash = hashIntakeToken(token);
    const enc = encryptToken(token);

    // datetime-local fields are wall time in the school timezone
    // (Asia/Jerusalem) — NOT the server timezone (UTC on Vercel)
    const [oDate, oTime] = parsed.data.opensAt.split("T");
    const [cDate, cTime] = parsed.data.closesAt.split("T");
    const [oy, om, od] = oDate.split("-").map(Number);
    const [oh, omi] = oTime.split(":").map(Number);
    const [cy, cm, cd] = cDate.split("-").map(Number);
    const [ch, cmi] = cTime.split(":").map(Number);
    const opensAtIso = jerusalemWallTimeToUtc(oy, om, od, oh, omi).toISOString();
    const closesAtIso = jerusalemWallTimeToUtc(cy, cm, cd, ch, cmi).toISOString();

    const admin = createAdminClient();
    const { error } = await admin.from("intake_windows").insert({
      title: parsed.data.title,
      token_hash: tokenHash,
      opens_at: opensAtIso,
      closes_at: closesAtIso,
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
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
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
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

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

/** Copy the SAME public link — decrypts the stored recoverable token.
 *  Never mutates the DB, never rotates or invalidates a token. */
export async function copyIntakeLinkAction(
  windowId: string
): Promise<{ ok: boolean; url?: string; needsReissue?: boolean; error?: string }> {
  try {
    const { allowed } = await requireCoordinator();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    if (!/^[0-9a-f-]{36}$/i.test(windowId)) return { ok: false, error: "קלט לא תקין" };
    const admin = createAdminClient();

    // 1) the window's own recoverable token (created with the window)
    const { data: w } = await admin
      .from("intake_windows")
      .select("encrypted_token, encryption_iv, encryption_tag")
      .eq("id", windowId)
      .maybeSingle();
    if (w?.encrypted_token && w?.encryption_iv && w?.encryption_tag) {
      const { decryptToken } = await import("@/lib/intake-crypto");
      const raw = decryptToken(w.encrypted_token, w.encryption_iv, w.encryption_tag);
      if (raw) return { ok: true, url: raw };
    }

    // 2) an additional recoverable token from intake_window_tokens
    const { data: tokens } = await admin
      .from("intake_window_tokens")
      .select("encrypted_token, encryption_iv, encryption_tag")
      .eq("intake_window_id", windowId)
      .is("revoked_at", null)
      .not("encrypted_token", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const t = (tokens ?? [])[0] as
      | { encrypted_token: string; encryption_iv: string; encryption_tag: string }
      | undefined;
    if (t?.encrypted_token && t?.encryption_iv && t?.encryption_tag) {
      const { decryptToken } = await import("@/lib/intake-crypto");
      const raw = decryptToken(t.encrypted_token, t.encryption_iv, t.encryption_tag);
      if (raw) return { ok: true, url: raw };
    }

    return { ok: false, needsReissue: true };
  } catch {
    return { ok: false, error: "שגיאה בהעתקת הקישור" };
  }
}

/**
 * LEGACY windows only: generate an ADDITIONAL recoverable public token.
 * The original legacy token (intake_windows.token_hash) is left untouched,
 * so the existing public link keeps working. The new raw token is stored
 * ONLY as its SHA-256 hash + encrypted copy (never plaintext at rest).
 */
export async function reissueIntakeTokenAction(
  windowId: string
): Promise<{ ok: boolean; token?: string; error?: string }> {
  try {
    const { me, allowed } = await requireCoordinator();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(32).toString("base64url");
    const enc = encryptToken(token);

    const admin = createAdminClient();
    // sanity: the window must exist (and not be soft-deleted)
    const { data: w } = await admin
      .from("intake_windows")
      .select("id")
      .eq("id", windowId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!w) return { ok: false, error: "הטופס לא נמצא" };

    // ADD a token row — do NOT touch intake_windows.token_hash
    const { error } = await admin.from("intake_window_tokens").insert({
      intake_window_id: windowId,
      token_hash: hashIntakeToken(token),
      encrypted_token: enc.encrypted,
      encryption_iv: enc.iv,
      encryption_tag: enc.tag,
    });
    if (error) return { ok: false, error: "החידוש נכשל" };

    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "intake_token_added",
      entity_type: "intake_window",
      entity_id: windowId,
      metadata: {},
    });

    return { ok: true, token };
  } catch {
    return { ok: false, error: "החידוש נכשל" };
  }
}

/** Reactivate a disabled intake window — same token, same link, same config. */
export async function restoreIntakeWindowAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    const { me, allowed } = await requireCoordinator();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
    const id = String(fd.get("id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "קלט לא תקין" };

    const admin = createAdminClient();
    const { error } = await admin
      .from("intake_windows")
      .update({ is_revoked: false, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false, error: "ההפעלה מחדש נכשלה" };

    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "intake_window_restored",
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

/**
 * Delete an intake window.
 *  - no submissions  → hard delete (row removed; nothing historical lost)
 *  - has submissions → soft delete (deleted_at); management list hides it,
 *    submission history is preserved.
 * Both modes are audited. Distinct from disable (השבתה), which is reversible.
 */
export async function deleteIntakeWindowAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    const { me, allowed } = await requireCoordinator();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
    const id = String(fd.get("id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "קלט לא תקין" };

    const admin = createAdminClient();
    const { count, error: countErr } = await admin
      .from("intake_submissions")
      .select("id", { count: "exact", head: true })
      .eq("intake_id", id);
    if (countErr) return { ok: false, error: "המחיקה נכשלה" };
    const hasSubmissions = (count ?? 0) > 0;

    let error: { message: string } | null = null;
    if (hasSubmissions) {
      ({ error } = await admin
        .from("intake_windows")
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", id));
    } else {
      ({ error } = await admin.from("intake_windows").delete().eq("id", id));
    }
    if (error) return { ok: false, error: "המחיקה נכשלה" };

    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "intake_window_deleted",
      entity_type: "intake_window",
      entity_id: id,
      metadata: { mode: hasSubmissions ? "soft" : "hard" },
    });

    revalidatePath("/admin/intake");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}
