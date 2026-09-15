"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  staffEmailSchema,
  setRolesSchema,
  studentSchema,
  groupSchema,
  majorSchema,
  assignmentSchema,
  groupMentorsSchema,
  majorHeadsSchema,
  csvStudentRowSchema,
  csvStaffRowSchema,
} from "@/lib/validation";
import { isUuid } from "@/lib/validation";
import type { ActionState } from "@/lib/actions/messages";
import { parseCsv } from "@/lib/csv";

type Admin = Awaited<ReturnType<typeof createAdminClient>>;

async function withAdmin(
  fn: (admin: Admin, actorId: string) => Promise<ActionState>
): Promise<ActionState> {
  try {
    const me = await requireSuperAdmin();
    const admin = createAdminClient();
    return await fn(admin, me.userId);
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // Next redirects
    return { ok: false, error: humanizeError(e) };
  }
}

function humanizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("duplicate key")) return "ערך זה כבר קיים במערכת.";
  if (msg.includes("violates foreign key")) return "הפניה לא תקינה — בדקו את הבחירות.";
  if (msg.includes("not set")) return "תצורת השרת אינה מאפשרת ניהול (חסר מפתח שירות).";
  return "הפעולה נכשלה. נסו שוב.";
}

async function audit(
  admin: Admin,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await admin.from("audit_logs").insert({
    actor_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    metadata,
  });
}

// ----------------------------------------------------------------- helpers --

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}
function bool(fd: FormData, key: string): boolean {
  return fd.get(key) === "on" || fd.get(key) === "true";
}
function strArray(fd: FormData, key: string): string[] {
  return fd
    .getAll(key)
    .map((v) => String(v).trim())
    .filter(Boolean);
}
function uuidOrNull(v: string): string | null {
  return isUuid(v) ? v : null;
}

// ------------------------------------------------------------------ staff ---

export async function upsertStaffEmailAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = staffEmailSchema.safeParse({
      id: str(fd, "id") || undefined,
      email: str(fd, "email"),
      fullName: str(fd, "fullName"),
      isActive: bool(fd, "isActive"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const { id, email, fullName, isActive } = parsed.data;

    if (id) {
      const { error } = await admin
        .from("allowed_staff_emails")
        .update({ email, full_name: fullName || null, is_active: isActive })
        .eq("id", id);
      if (error) throw error;
      await audit(admin, actorId, "staff_allowlist_update", "allowed_staff_email", id, {
        email,
        is_active: isActive,
      });
    } else {
      const { data, error } = await admin
        .from("allowed_staff_emails")
        .insert({ email, full_name: fullName || null, is_active: isActive })
        .select("id")
        .single();
      if (error) throw error;
      await audit(admin, actorId, "staff_allowlist_add", "allowed_staff_email", data.id, {
        email,
        is_active: isActive,
      });
    }
    revalidatePath("/admin/staff");
    return { ok: true };
  });
}

export async function setUserRolesAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = setRolesSchema.safeParse({
      userId: str(fd, "userId"),
      roles: strArray(fd, "roles"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const { userId, roles } = parsed.data;
    await admin.from("user_roles").delete().eq("user_id", userId);
    if (roles.length > 0) {
      const { error } = await admin
        .from("user_roles")
        .insert(roles.map((role) => ({ user_id: userId, role })));
      if (error) throw error;
    }
    await audit(admin, actorId, "staff_roles_set", "profile", userId, { roles });
    revalidatePath("/admin/staff");
    return { ok: true };
  });
}

export async function deleteStaffEmailAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const id = str(fd, "id");
    if (!isUuid(id)) {
      return { ok: false, error: "קלט לא תקין" };
    }
    const { error } = await admin
      .from("allowed_staff_emails")
      .delete()
      .eq("id", id);
    if (error) throw error;
    await audit(admin, actorId, "staff_allowlist_delete", "allowed_staff_email", id);
    revalidatePath("/admin/staff");
    return { ok: true };
  });
}

export async function importStaffCsvAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const text = str(fd, "csv");
    if (!text) return { ok: false, error: "לא נבחר קובץ" };
    const rows = parseCsv(text);
    if (rows.length < 2) return { ok: false, error: "הקובץ ריק או ללא נתונים" };
    const header = rows[0].map((h) => h.trim());
    if (!header.includes("email")) {
      return { ok: false, error: 'השורה הראשונה חייבת לכלול עמודת "email" (ואופציונלי "full_name")' };
    }
    let added = 0;
    const errors: string[] = [];
    for (const r of rows.slice(1)) {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => (obj[h] = (r[i] ?? "").trim()));
      const parsed = csvStaffRowSchema.safeParse({
        email: obj.email,
        fullName: obj.full_name ?? "",
      });
      if (!parsed.success) {
        errors.push(obj.email || "(שורה ללא אימייל)");
        continue;
      }
      const { error } = await admin
        .from("allowed_staff_emails")
        .upsert(
          {
            email: parsed.data.email,
            full_name: parsed.data.fullName || null,
            is_active: true,
          },
          { onConflict: "email" }
        );
      if (error) errors.push(parsed.data.email);
      else added++;
    }
    await audit(admin, actorId, "staff_csv_import", "allowed_staff_email", null, {
      added,
      failed: errors.length,
    });
    revalidatePath("/admin/staff");
    return {
      ok: true,
      error:
        errors.length > 0
          ? `נוספו ${added} כתובות. נכשלו: ${errors.join(", ")}`
          : undefined,
    };
  });
}

// --------------------------------------------------------------- students ---

export async function upsertStudentAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = studentSchema.safeParse({
      id: str(fd, "id") || undefined,
      firstName: str(fd, "firstName"),
      lastName: str(fd, "lastName"),
      groupId: uuidOrNull(str(fd, "groupId")),
      majorId: uuidOrNull(str(fd, "majorId")),
      isArchived: bool(fd, "isArchived"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const s = parsed.data;
    const values = {
      first_name: s.firstName,
      last_name: s.lastName,
      group_id: s.groupId,
      major_id: s.majorId,
      is_archived: s.isArchived,
    };
    if (s.id) {
      const { error } = await admin.from("students").update(values).eq("id", s.id);
      if (error) throw error;
      await audit(admin, actorId, "student_update", "student", s.id, values);
    } else {
      const { data, error } = await admin
        .from("students")
        .insert(values)
        .select("id")
        .single();
      if (error) throw error;
      await audit(admin, actorId, "student_create", "student", data.id, values);
    }
    revalidatePath("/admin/students");
    revalidatePath("/");
    return { ok: true };
  });
}

export async function archiveStudentAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const id = str(fd, "id");
    const archived = bool(fd, "isArchived");
    if (!isUuid(id)) {
      return { ok: false, error: "קלט לא תקין" };
    }
    const { error } = await admin
      .from("students")
      .update({ is_archived: archived })
      .eq("id", id);
    if (error) throw error;
    await audit(admin, actorId, archived ? "student_archive" : "student_restore", "student", id);
    revalidatePath("/admin/students");
    revalidatePath("/");
    return { ok: true };
  });
}

export async function setMastersAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = assignmentSchema.safeParse({
      studentId: str(fd, "studentId"),
      masterIds: strArray(fd, "masterIds"),
    });
    if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
    const { studentId, masterIds } = parsed.data;
    await admin.from("master_assignments").delete().eq("student_id", studentId);
    if (masterIds.length > 0) {
      const { error } = await admin
        .from("master_assignments")
        .insert(masterIds.map((master_id) => ({ student_id: studentId, master_id })));
      if (error) throw error;
    }
    await audit(admin, actorId, "master_assignments_set", "student", studentId, {
      masterIds,
    });
    revalidatePath("/admin/students");
    return { ok: true };
  });
}

export async function importStudentsCsvAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const text = str(fd, "csv");
    if (!text) return { ok: false, error: "לא נבחר קובץ" };
    const rows = parseCsv(text);
    if (rows.length < 2) return { ok: false, error: "הקובץ ריק או ללא נתונים" };
    const header = rows[0].map((h) => h.trim());
    const needed = ["first_name", "last_name", "group"];
    for (const col of needed) {
      if (!header.includes(col)) {
        return {
          ok: false,
          error: `חסרה עמודת "${col}" בשורה הראשונה (עמודות: first_name, last_name, group, major אופציונלי)`,
        };
      }
    }
    const { data: groups } = await admin.from("greenhouse_groups").select("id, name");
    const { data: majors } = await admin.from("majors").select("id, name");
    const groupMap = new Map((groups ?? []).map((g) => [g.name, g.id]));
    const majorMap = new Map((majors ?? []).map((m) => [m.name, m.id]));

    let added = 0;
    const errors: string[] = [];
    for (const r of rows.slice(1)) {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => (obj[h] = (r[i] ?? "").trim()));
      const parsed = csvStudentRowSchema.safeParse({
        firstName: obj.first_name,
        lastName: obj.last_name,
        groupName: obj.group,
        majorName: obj.major ?? "",
      });
      if (!parsed.success) {
        errors.push(`${obj.first_name ?? "?"} ${obj.last_name ?? ""}`.trim());
        continue;
      }
      const groupId = groupMap.get(parsed.data.groupName);
      if (!groupId) {
        errors.push(`${parsed.data.firstName} ${parsed.data.lastName} (קבוצה לא קיימת)`);
        continue;
      }
      const { error } = await admin.from("students").insert({
        first_name: parsed.data.firstName,
        last_name: parsed.data.lastName,
        group_id: groupId,
        major_id: parsed.data.majorName ? majorMap.get(parsed.data.majorName) ?? null : null,
      });
      if (error) errors.push(`${parsed.data.firstName} ${parsed.data.lastName}`);
      else added++;
    }
    await audit(admin, actorId, "students_csv_import", "student", null, {
      added,
      failed: errors.length,
    });
    revalidatePath("/admin/students");
    revalidatePath("/");
    return {
      ok: true,
      error:
        errors.length > 0
          ? `נוספו ${added} חניכים. נכשלו: ${errors.join(", ")}`
          : undefined,
    };
  });
}

// ----------------------------------------------------------------- groups ---

export async function upsertGroupAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = groupSchema.safeParse({
      id: str(fd, "id") || undefined,
      name: str(fd, "name"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    if (parsed.data.id) {
      const { error } = await admin
        .from("greenhouse_groups")
        .update({ name: parsed.data.name })
        .eq("id", parsed.data.id);
      if (error) throw error;
      await audit(admin, actorId, "group_update", "greenhouse_group", parsed.data.id, {
        name: parsed.data.name,
      });
    } else {
      const { data, error } = await admin
        .from("greenhouse_groups")
        .insert({ name: parsed.data.name })
        .select("id")
        .single();
      if (error) throw error;
      await audit(admin, actorId, "group_create", "greenhouse_group", data.id, {
        name: parsed.data.name,
      });
    }
    revalidatePath("/admin/groups");
    revalidatePath("/groups");
    return { ok: true };
  });
}

export async function setGroupMentorsAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = groupMentorsSchema.safeParse({
      groupId: str(fd, "groupId"),
      mentorIds: strArray(fd, "mentorIds"),
    });
    if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
    const { groupId, mentorIds } = parsed.data;
    await admin.from("group_mentors").delete().eq("group_id", groupId);
    if (mentorIds.length > 0) {
      const { error } = await admin
        .from("group_mentors")
        .insert(mentorIds.map((mentor_id) => ({ group_id: groupId, mentor_id })));
      if (error) throw error;
    }
    await audit(admin, actorId, "group_mentors_set", "greenhouse_group", groupId, {
      mentorIds,
    });
    revalidatePath("/admin/groups");
    revalidatePath("/groups");
    return { ok: true };
  });
}

// ----------------------------------------------------------------- majors ---

export async function upsertMajorAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = majorSchema.safeParse({
      id: str(fd, "id") || undefined,
      name: str(fd, "name"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    if (parsed.data.id) {
      const { error } = await admin
        .from("majors")
        .update({ name: parsed.data.name })
        .eq("id", parsed.data.id);
      if (error) throw error;
      await audit(admin, actorId, "major_update", "major", parsed.data.id, {
        name: parsed.data.name,
      });
    } else {
      const { data, error } = await admin
        .from("majors")
        .insert({ name: parsed.data.name })
        .select("id")
        .single();
      if (error) throw error;
      await audit(admin, actorId, "major_create", "major", data.id, {
        name: parsed.data.name,
      });
    }
    revalidatePath("/admin/majors");
    revalidatePath("/majors");
    return { ok: true };
  });
}

export async function setMajorHeadsAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const parsed = majorHeadsSchema.safeParse({
      majorId: str(fd, "majorId"),
      headIds: strArray(fd, "headIds"),
    });
    if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
    const { majorId, headIds } = parsed.data;
    await admin.from("major_heads").delete().eq("major_id", majorId);
    if (headIds.length > 0) {
      const { error } = await admin
        .from("major_heads")
        .insert(headIds.map((head_id) => ({ major_id: majorId, head_id })));
      if (error) throw error;
    }
    await audit(admin, actorId, "major_heads_set", "major", majorId, { headIds });
    revalidatePath("/admin/majors");
    revalidatePath("/majors");
    return { ok: true };
  });
}

// --------------------------------------------------------------- settings ---

export async function setIncludeNameInPushAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorId) => {
    const value = bool(fd, "includeName");
    const { error } = await admin
      .from("app_settings")
      .upsert(
        { key: "include_student_name_in_push", value, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    if (error) throw error;
    await audit(admin, actorId, "app_setting_set", "app_setting", null, {
      key: "include_student_name_in_push",
      value,
    });
    revalidatePath("/admin/settings");
    return { ok: true };
  });
}
