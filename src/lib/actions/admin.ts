"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import {
  staffCreateSchema,
  staffUpdateSchema,
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
  fn: (admin: Admin, actorStaffId: string) => Promise<ActionState>
): Promise<ActionState> {
  try {
    const me = await requireSuperAdmin();
    if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
    const admin = createAdminClient();
    return await fn(admin, me.staffId);
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
  actorStaffId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await admin.from("audit_logs").insert({
    actor_staff_id: actorStaffId,
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
// Creating a staff member goes through the admin_create_staff RPC: staff row
// + initial roles are written atomically, and the caller's super_admin
// status is verified inside the database function itself.

export async function createStaffAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  try {
    await requireSuperAdmin();
    const parsed = staffCreateSchema.safeParse({
      email: str(fd, "email"),
      fullName: str(fd, "fullName"),
      isActive: bool(fd, "isActive"),
      roles: strArray(fd, "roles"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_create_staff", {
      p_email: parsed.data.email,
      p_full_name: parsed.data.fullName || null,
      p_is_active: parsed.data.isActive,
      p_roles: parsed.data.roles,
    });
    if (error) {
      if (error.message.includes("duplicate key")) {
        return { ok: false, error: "כתובת האימייל כבר קיימת בספר הצוות." };
      }
      return { ok: false, error: humanizeError(error) };
    }
    revalidatePath("/admin/staff");
    return { ok: true };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    return { ok: false, error: humanizeError(e) };
  }
}

export async function updateStaffAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorStaffId) => {
    const parsed = staffUpdateSchema.safeParse({
      id: str(fd, "id"),
      fullName: str(fd, "fullName"),
      isActive: bool(fd, "isActive"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const { id, fullName, isActive } = parsed.data;
    const { error } = await admin
      .from("profiles")
      .update({ full_name: fullName || null, is_active: isActive })
      .eq("id", id);
    if (error) throw error;
    await audit(admin, actorStaffId, "staff_member_update", "staff_member", id, {
      full_name: fullName,
      is_active: isActive,
    });
    revalidatePath("/admin/staff");
    return { ok: true };
  });
}

export async function setUserRolesAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorStaffId) => {
    const parsed = setRolesSchema.safeParse({
      staffId: str(fd, "staffId"),
      roles: strArray(fd, "roles"),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const { staffId, roles } = parsed.data;
    await admin.from("user_roles").delete().eq("staff_id", staffId);
    if (roles.length > 0) {
      const { error } = await admin
        .from("user_roles")
        .insert(roles.map((role) => ({ staff_id: staffId, role })));
      if (error) throw error;
    }
    await audit(admin, actorStaffId, "staff_roles_set", "staff_member", staffId, {
      roles,
    });
    revalidatePath("/admin/staff");
    return { ok: true };
  });
}

export async function importStaffCsvAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorStaffId) => {
    const text = str(fd, "csv");
    if (!text) return { ok: false, error: "לא נבחר קובץ" };
    const rows = parseCsv(text);
    if (rows.length < 2) return { ok: false, error: "הקובץ ריק או ללא נתונים" };
    const header = rows[0].map((h) => h.trim());
    if (!header.includes("email")) {
      return { ok: false, error: 'השורה הראשונה חייבת לכלול עמודת "email" (ואופציונלי "full_name")' };
    }

    const { data: existing } = await admin
      .from("profiles")
      .select("email");
    const existingEmails = new Set(
      (existing ?? []).map((p) => String(p.email).toLowerCase())
    );

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
      if (existingEmails.has(parsed.data.email)) continue; // already present
      const { error } = await admin.from("profiles").insert({
        email: parsed.data.email,
        full_name: parsed.data.fullName || null,
        is_active: true,
        auth_user_id: null, // staff exists before first login
      });
      if (error) errors.push(parsed.data.email);
      else {
        added++;
        existingEmails.add(parsed.data.email);
      }
    }
    await audit(admin, actorStaffId, "staff_csv_import", "staff_member", null, {
      added,
      failed: errors.length,
    });
    revalidatePath("/admin/staff");
    return {
      ok: true,
      error:
        errors.length > 0
          ? `נוספו ${added} אנשי סגל. נכשלו: ${errors.join(", ")}`
          : undefined,
    };
  });
}

// --------------------------------------------------------------- students ---

export async function upsertStudentAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorStaffId) => {
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
      await audit(admin, actorStaffId, "student_update", "student", s.id, values);
    } else {
      const { data, error } = await admin
        .from("students")
        .insert(values)
        .select("id")
        .single();
      if (error) throw error;
      await audit(admin, actorStaffId, "student_create", "student", data.id, values);
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
  return withAdmin(async (admin, actorStaffId) => {
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
    await audit(admin, actorStaffId, archived ? "student_archive" : "student_restore", "student", id);
    revalidatePath("/admin/students");
    revalidatePath("/");
    return { ok: true };
  });
}

export async function setMastersAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorStaffId) => {
    const parsed = assignmentSchema.safeParse({
      studentId: str(fd, "studentId"),
      staffIds: strArray(fd, "staffIds"),
    });
    if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
    const { studentId, staffIds } = parsed.data;
    await admin.from("master_assignments").delete().eq("student_id", studentId);
    if (staffIds.length > 0) {
      const { error } = await admin
        .from("master_assignments")
        .insert(staffIds.map((staff_id) => ({ student_id: studentId, staff_id })));
      if (error) throw error;
    }
    await audit(admin, actorStaffId, "master_assignments_set", "student", studentId, {
      staffIds,
    });
    revalidatePath("/admin/students");
    return { ok: true };
  });
}

export async function importStudentsCsvAction(
  _prev: ActionState | null,
  fd: FormData
): Promise<ActionState> {
  return withAdmin(async (admin, actorStaffId) => {
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
    await audit(admin, actorStaffId, "students_csv_import", "student", null, {
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
  return withAdmin(async (admin, actorStaffId) => {
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
      await audit(admin, actorStaffId, "group_update", "greenhouse_group", parsed.data.id, {
        name: parsed.data.name,
      });
    } else {
      const { data, error } = await admin
        .from("greenhouse_groups")
        .insert({ name: parsed.data.name })
        .select("id")
        .single();
      if (error) throw error;
      await audit(admin, actorStaffId, "group_create", "greenhouse_group", data.id, {
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
  return withAdmin(async (admin, actorStaffId) => {
    const parsed = groupMentorsSchema.safeParse({
      groupId: str(fd, "groupId"),
      staffIds: strArray(fd, "staffIds"),
    });
    if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
    const { groupId, staffIds } = parsed.data;
    await admin.from("group_mentors").delete().eq("group_id", groupId);
    if (staffIds.length > 0) {
      const { error } = await admin
        .from("group_mentors")
        .insert(staffIds.map((staff_id) => ({ group_id: groupId, staff_id })));
      if (error) throw error;
    }
    await audit(admin, actorStaffId, "group_mentors_set", "greenhouse_group", groupId, {
      staffIds,
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
  return withAdmin(async (admin, actorStaffId) => {
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
      await audit(admin, actorStaffId, "major_update", "major", parsed.data.id, {
        name: parsed.data.name,
      });
    } else {
      const { data, error } = await admin
        .from("majors")
        .insert({ name: parsed.data.name })
        .select("id")
        .single();
      if (error) throw error;
      await audit(admin, actorStaffId, "major_create", "major", data.id, {
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
  return withAdmin(async (admin, actorStaffId) => {
    const parsed = majorHeadsSchema.safeParse({
      majorId: str(fd, "majorId"),
      staffIds: strArray(fd, "staffIds"),
    });
    if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
    const { majorId, staffIds } = parsed.data;
    await admin.from("major_heads").delete().eq("major_id", majorId);
    if (staffIds.length > 0) {
      const { error } = await admin
        .from("major_heads")
        .insert(staffIds.map((staff_id) => ({ major_id: majorId, staff_id })));
      if (error) throw error;
    }
    await audit(admin, actorStaffId, "major_heads_set", "major", majorId, { staffIds });
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
  return withAdmin(async (admin, actorStaffId) => {
    const value = bool(fd, "includeName");
    const { error } = await admin
      .from("app_settings")
      .upsert(
        { key: "include_student_name_in_push", value, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    if (error) throw error;
    await audit(admin, actorStaffId, "app_setting_set", "app_setting", null, {
      key: "include_student_name_in_push",
      value,
    });
    revalidatePath("/admin/settings");
    return { ok: true };
  });
}
