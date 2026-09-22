import { cache } from "react";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/permissions";

/**
 * Current staff identity.
 *
 * staffId is the STABLE application UUID (profiles.id) — it exists before the
 * person ever logs in and never changes. It is resolved through the
 * authenticated Supabase account via profiles.auth_user_id (claimed at first
 * login by the database-side claim_staff_identity() RPC).
 *
 * mentorGroupIds / masterStudentIds are the person's CANONICAL relationships
 * (group_mentors / master_assignments) — never derived from the role list.
 */
export interface Me {
  staffId: string | null;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  roles: Role[];
  isActive: boolean;
  mentorGroupIds: string[];
  masterStudentIds: string[];
}

interface StaffContextRow {
  staff_id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  is_active: boolean;
  roles: Role[] | null;
  mentor_group_ids: string[] | null;
  master_student_ids: string[] | null;
}

/**
 * Pre-20260923000004 resolution (sequential RLS-scoped queries). Used only
 * when current_staff_context() is not deployed yet, so an app deploy that
 * lands before the migration keeps working instead of locking everyone out.
 */
async function legacyStaffContext(
  supabase: SupabaseClient,
  authUserId: string
): Promise<StaffContextRow | null> {
  const { data: staff } = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url, is_active")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (!staff) return null;
  const [roleRows, mentorRows, masterRows] = await Promise.all([
    supabase.from("user_roles").select("role").eq("staff_id", staff.id),
    supabase.from("group_mentors").select("group_id").eq("staff_id", staff.id),
    supabase.from("master_assignments").select("student_id").eq("staff_id", staff.id),
  ]);
  return {
    staff_id: staff.id,
    email: staff.email,
    full_name: staff.full_name,
    avatar_url: staff.avatar_url,
    is_active: Boolean(staff.is_active),
    roles: (roleRows.data ?? []).map((r) => r.role as Role),
    mentor_group_ids: (mentorRows.data ?? []).map((r) => r.group_id as string),
    master_student_ids: (masterRows.data ?? []).map((r) => r.student_id as string),
  };
}

/**
 * Resolve the current authenticated account to its staff identity.
 *
 * Request-scoped (React cache): the layout, the page and every helper share
 * ONE resolution per request — never across requests or users.
 *
 * The auth-server verification (getUser) and the identity lookup are
 * independent round trips, so they run concurrently. The identity RPC is
 * keyed by auth.uid() of the same session token inside the database; its
 * result is only used once getUser has verified that session.
 */
export const getMe = cache(async (): Promise<Me | null> => {
  const supabase = await createClient();
  const [
    {
      data: { user },
    },
    ctxRes,
  ] = await Promise.all([
    supabase.auth.getUser(),
    supabase.rpc("current_staff_context").maybeSingle<StaffContextRow>(),
  ]);
  if (!user) return null;

  let staff: StaffContextRow | null = ctxRes.data ?? null;
  if (ctxRes.error) {
    console.error(
      "[auth] current_staff_context unavailable, using sequential lookup:",
      ctxRes.error.message
    );
    staff = await legacyStaffContext(supabase, user.id);
  }

  return {
    staffId: staff?.staff_id ?? null,
    email: staff?.email ?? user.email ?? "",
    fullName: staff?.full_name ?? null,
    avatarUrl: staff?.avatar_url ?? null,
    roles: staff?.roles ?? [],
    isActive: Boolean(staff?.is_active),
    mentorGroupIds: staff?.mentor_group_ids ?? [],
    masterStudentIds: staff?.master_student_ids ?? [],
  };
});

/** Guard for all staff pages. Handles session expiry + unauthorized accounts. */
export async function requireMe(): Promise<Me> {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!me.isActive) redirect("/access-denied");
  return me;
}

export function hasRole(me: Me, role: Role): boolean {
  return me.roles.includes(role);
}

export function isPrivileged(me: Me): boolean {
  return me.roles.some((r) =>
    (
      ["counselor", "project_coordinator", "leadership"] as const
    ).includes(r as "counselor")
  );
}

export { canAccessManagement } from "@/lib/permissions";

export async function requireSuperAdmin(): Promise<Me> {
  const me = await requireMe();
  if (!hasRole(me, "super_admin")) redirect("/?error=אין%20הרשאת%20מנהל");
  return me;
}
