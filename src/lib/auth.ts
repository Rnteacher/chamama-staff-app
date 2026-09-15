import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/permissions";

export interface Me {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  roles: Role[];
  isActive: boolean;
}

/** Full current-user context. null when signed out. */
export async function getMe(): Promise<Me | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [profileRes, rolesRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("email, full_name, avatar_url, is_active")
      .eq("id", user.id)
      .maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", user.id),
  ]);

  return {
    userId: user.id,
    email: profileRes?.data?.email ?? user.email ?? "",
    fullName: profileRes?.data?.full_name ?? null,
    avatarUrl: profileRes?.data?.avatar_url ?? null,
    roles: (rolesRes.data ?? []).map((r) => r.role as Role),
    isActive: profileRes?.data?.is_active ?? false,
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
