import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/permissions";

/**
 * Current staff identity.
 *
 * staffId is the STABLE application UUID (profiles.id) — it exists before the
 * person ever logs in and never changes. It is resolved through the
 * authenticated Supabase account via profiles.auth_user_id (claimed at first
 * login by the database-side claim_staff_identity() RPC).
 */
export interface Me {
  staffId: string | null;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  roles: Role[];
  isActive: boolean;
}

/** Resolve the current authenticated account to its staff identity. */
export async function getMe(): Promise<Me | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // The staff row linked to this auth account (claimed at first login).
  const { data: staff } = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url, is_active")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  let roles: Role[] = [];
  if (staff) {
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("role")
      .eq("staff_id", staff.id);
    roles = (roleRows ?? []).map((r) => r.role as Role);
  }

  return {
    staffId: staff?.id ?? null,
    email: staff?.email ?? user.email ?? "",
    fullName: staff?.full_name ?? null,
    avatarUrl: staff?.avatar_url ?? null,
    roles,
    isActive: Boolean(staff?.is_active),
  };
}

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

export async function requireSuperAdmin(): Promise<Me> {
  const me = await requireMe();
  if (!hasRole(me, "super_admin")) redirect("/?error=אין%20הרשאת%20מנהל");
  return me;
}
