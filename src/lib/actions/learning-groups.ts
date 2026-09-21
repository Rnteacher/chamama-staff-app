"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { requireMe, hasRole } from "@/lib/auth";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import {
  learningGroupSchema,
  learningGroupWindowSchema,
  isUuid,
} from "@/lib/validation";
import { hashIntakeToken } from "@/lib/intake-token";
import { encryptToken } from "@/lib/intake-crypto";
import { jerusalemWallTimeToUtc } from "@/lib/meetings";
import type { ActionState } from "@/lib/actions/messages";
import { assertNotViewAs } from "@/lib/view-as";

/**
 * Learning Groups phase — server actions.
 *
 * Permissions (enforced here AND inside the database RPCs):
 *   * create/edit group definition: leadership / super_admin
 *   * membership add/remove: staff leaders of THAT group / leadership /
 *     super_admin — the RPC is the authorization boundary, so a direct RPC
 *     call can never bypass it.
 *   * View-As: NO mutations (assertNotViewAs before anything).
 */

export type LearningGroupUpsertResult =
  | { ok: true; id?: string }
  | { ok: false; error: string };

async function requireLearningGroupAdmin() {
  const me = await requireMe();
  const allowed =
    me.staffId !== null && (hasRole(me, "leadership") || hasRole(me, "super_admin"));
  return { me, allowed };
}

function strArray(fd: FormData, key: string): string[] {
  return fd
    .getAll(key)
    .map((v) => String(v).trim())
    .filter(Boolean);
}

// ------------------------------------------------------------ definition ---

export async function upsertLearningGroupAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<LearningGroupUpsertResult> {
  try {
    const { allowed } = await requireLearningGroupAdmin();
    if (!allowed) return { ok: false, error: "אין הרשאה לניהול קבוצות למידה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };

    const weekdays = strArray(fd, "slotWeekday");
    const starts = strArray(fd, "slotStart");
    const ends = strArray(fd, "slotEnd");
    const slots = weekdays
      .map((w, i) => ({
        weekday: Number(w),
        startTime: starts[i] ?? "",
        endTime: ends[i] ?? "",
      }))
      .filter((s) => Number.isInteger(s.weekday) || s.startTime || s.endTime);

    const parsed = learningGroupSchema.safeParse({
      id: String(fd.get("id") ?? "") || undefined,
      name: String(fd.get("name") ?? ""),
      description: String(fd.get("description") ?? ""),
      isActive: fd.get("isActive") === "on" || fd.get("isActive") === "true",
      slots,
      staffLeaderIds: strArray(fd, "staffLeaderIds").filter(isUuid),
      studentLeaderIds: strArray(fd, "studentLeaderIds").filter(isUuid),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }

    // authorization + slot/duplicate validation + audit happen INSIDE the RPC
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_upsert_learning_group", {
      p_id: parsed.data.id ?? null,
      p_name: parsed.data.name,
      p_description: parsed.data.description || null,
      p_is_active: parsed.data.isActive,
      p_slots: parsed.data.slots.map((s) => ({
        weekday: s.weekday,
        start_time: s.startTime,
        end_time: s.endTime,
      })),
      p_staff_leader_ids: parsed.data.staffLeaderIds,
      p_student_leader_ids: parsed.data.studentLeaderIds,
    });
    if (error) {
      if (error.message.includes("Only leadership or super_admin"))
        return { ok: false, error: "אין הרשאה לניהול קבוצות למידה" };
      if (error.message.includes("duplicate key"))
        return { ok: false, error: "קבוצה בשם זה כבר קיימת" };
      return { ok: false, error: error.message || "השמירה נכשלה. נסו שוב." };
    }
    const res = (data ?? {}) as { id?: string };

    revalidatePath("/admin/learning-groups");
    revalidatePath("/groups");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// ------------------------------------------------------------- members -----

export async function addLearningGroupMemberAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireMe(); // must be a signed-in staff identity; RPC authorizes
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const groupId = String(fd.get("groupId") ?? "");
    const studentId = String(fd.get("studentId") ?? "");
    if (!isUuid(groupId) || !isUuid(studentId)) return { ok: false, error: "קלט לא תקין" };

    const supabase = await createClient();
    const { error } = await supabase.rpc("learning_group_add_member", {
      p_group_id: groupId,
      p_student_id: studentId,
    });
    if (error) {
      if (error.message.includes("Only a leader of this learning group"))
        return { ok: false, error: "אין הרשאה לניהול חניכים בקבוצה זו" };
      return { ok: false, error: "הוספת החניך/ה נכשלה. נסו שוב." };
    }

    revalidatePath(`/groups/learning/${groupId}`);
    revalidatePath("/groups");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function removeLearningGroupMemberAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireMe();
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    const groupId = String(fd.get("groupId") ?? "");
    const studentId = String(fd.get("studentId") ?? "");
    if (!isUuid(groupId) || !isUuid(studentId)) return { ok: false, error: "קלט לא תקין" };

    const supabase = await createClient();
    const { error } = await supabase.rpc("learning_group_remove_member", {
      p_group_id: groupId,
      p_student_id: studentId,
    });
    if (error) {
      if (error.message.includes("Only a leader of this learning group"))
        return { ok: false, error: "אין הרשאה לניהול חניכים בקבוצה זו" };
      return { ok: false, error: "הסרת החניך/ה נכשלה. נסו שוב." };
    }

    revalidatePath(`/groups/learning/${groupId}`);
    revalidatePath("/groups");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

// ---------------------------------------------------- registration windows --

export type LgregWindowCreateResult =
  | { ok: true; token?: string }
  | { ok: false; error: string };

export async function createLearningGroupWindowAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<LgregWindowCreateResult> {
  try {
    const { me, allowed } = await requireLearningGroupAdmin();
    if (!allowed) return { ok: false, error: "אין הרשאה ליצירת טפסי הרשמה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };

    const parsed = learningGroupWindowSchema.safeParse({
      title: String(fd.get("title") ?? "").trim(),
      opensAt: String(fd.get("opensAt") ?? ""),
      closesAt: String(fd.get("closesAt") ?? ""),
      learningGroupIds: strArray(fd, "learningGroupIds").filter(isUuid),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }

    // cryptographically unguessable public token; stored as SHA-256 hash +
    // encrypted recoverable copy (never plaintext at rest)
    const token = randomBytes(32).toString("base64url");
    const enc = encryptToken(token);

    // datetime-local fields are wall time in the school timezone
    const toUtc = (v: string): string => {
      const [d, t] = v.split("T");
      const [y, m, day] = d.split("-").map(Number);
      const [h, mi] = t.split(":").map(Number);
      return jerusalemWallTimeToUtc(y, m, day, h, mi).toISOString();
    };

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("learning_group_registration_windows")
      .insert({
        title: parsed.data.title,
        token_hash: hashIntakeToken(token),
        encrypted_token: enc.encrypted,
        encryption_iv: enc.iv,
        encryption_tag: enc.tag,
        opens_at: toUtc(parsed.data.opensAt),
        closes_at: toUtc(parsed.data.closesAt),
        created_by_staff_id: me.staffId,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: "יצירת טופס ההרשמה נכשלה" };

    const { error: groupsError } = await admin
      .from("learning_group_registration_window_groups")
      .insert(
        parsed.data.learningGroupIds.map((learning_group_id) => ({
          registration_window_id: data.id,
          learning_group_id,
        }))
      );
    if (groupsError) return { ok: false, error: "שמירת קבוצות ההרשמה נכשלה" };

    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "learning_group_window_created",
      entity_type: "learning_group_registration_window",
      entity_id: data.id,
      metadata: {
        title: parsed.data.title,
        opens_at: parsed.data.opensAt,
        closes_at: parsed.data.closesAt,
        groups: parsed.data.learningGroupIds.length,
      },
    });

    revalidatePath("/admin/learning-groups");
    return { ok: true, token };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

export async function revokeLearningGroupWindowAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    const { me, allowed } = await requireLearningGroupAdmin();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
    const id = String(fd.get("id") ?? "");
    if (!isUuid(id)) return { ok: false, error: "קלט לא תקין" };

    const admin = createAdminClient();
    const { error } = await admin
      .from("learning_group_registration_windows")
      .update({ is_revoked: true, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false, error: "השבתת הטופס נכשלה" };

    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "learning_group_window_revoked",
      entity_type: "learning_group_registration_window",
      entity_id: id,
      metadata: {},
    });

    revalidatePath("/admin/learning-groups");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

/**
 * Delete a registration window:
 *  - no registrations → hard delete
 *  - has registrations → soft delete (deleted_at); history preserved.
 */
export async function deleteLearningGroupWindowAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    const { me, allowed } = await requireLearningGroupAdmin();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
    const id = String(fd.get("id") ?? "");
    if (!isUuid(id)) return { ok: false, error: "קלט לא תקין" };

    const admin = createAdminClient();
    const { count, error: countErr } = await admin
      .from("learning_group_registrations")
      .select("id", { count: "exact", head: true })
      .eq("registration_window_id", id);
    if (countErr) return { ok: false, error: "המחיקה נכשלה" };
    const hasRegistrations = (count ?? 0) > 0;

    let error: { message: string } | null = null;
    if (hasRegistrations) {
      ({ error } = await admin
        .from("learning_group_registration_windows")
        .update({
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id));
    } else {
      ({ error } = await admin
        .from("learning_group_registration_windows")
        .delete()
        .eq("id", id));
    }
    if (error) return { ok: false, error: "המחיקה נכשלה" };

    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "learning_group_window_deleted",
      entity_type: "learning_group_registration_window",
      entity_id: id,
      metadata: { mode: hasRegistrations ? "soft" : "hard" },
    });

    revalidatePath("/admin/learning-groups");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: "הפעולה נכשלה. נסו שוב." };
  }
}

/**
 * Copy the SAME public link — decrypts the stored recoverable token and
 * returns the raw token. The CLIENT builds the absolute URL from its own
 * origin (canonical path builder). Never mutates the DB, never rotates.
 */
export async function copyLearningGroupLinkAction(
  windowId: string
): Promise<{ ok: boolean; token?: string; error?: string }> {
  try {
    const { allowed } = await requireLearningGroupAdmin();
    if (!allowed) return { ok: false, error: "אין הרשאה" };
    if (!(await assertNotViewAs())) return { ok: false, error: "לא זמין במצב צפייה" };
    if (!isUuid(windowId)) return { ok: false, error: "קלט לא תקין" };

    const admin = createAdminClient();
    const { data: w } = await admin
      .from("learning_group_registration_windows")
      .select("encrypted_token, encryption_iv, encryption_tag")
      .eq("id", windowId)
      .maybeSingle();
    if (w?.encrypted_token && w?.encryption_iv && w?.encryption_tag) {
      const { decryptToken } = await import("@/lib/intake-crypto");
      const raw = decryptToken(w.encrypted_token, w.encryption_iv, w.encryption_tag);
      if (raw) return { ok: true, token: raw };
    }
    return { ok: false, error: "הקישור אינו ניתן לשחזור" };
  } catch {
    return { ok: false, error: "שגיאה בהעתקת הקישור" };
  }
}
