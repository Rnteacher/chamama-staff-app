import "server-only";

import { cookies } from "next/headers";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const VIEW_AS_COOKIE = "view_as_staff";

export interface ViewAsState {
  active: boolean;
  staffId: string | null;
  staffName: string | null;
  roleContext: string | null;
}

/** Read the current View-As state (server-side only, read-only). */
export async function getViewAsState(): Promise<ViewAsState> {
  const me = await requireMe();
  if (!me || !hasRole(me, "super_admin")) {
    return { active: false, staffId: null, staffName: null, roleContext: null };
  }
  const cookieStore = await cookies();
  const staffId = cookieStore.get(VIEW_AS_COOKIE)?.value ?? null;
  if (!staffId || !/^[0-9a-f-]{36}$/i.test(staffId)) {
    return { active: false, staffId: null, staffName: null, roleContext: null };
  }
  const supabase = await createClient();
  const { data: staff } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("id", staffId)
    .eq("is_active", true)
    .maybeSingle();
  if (!staff) {
    return { active: false, staffId: null, staffName: null, roleContext: null };
  }
  const roleContext = cookieStore.get("view_as_role")?.value ?? "staff";
  return {
    active: true,
    staffId: staff.id,
    staffName: staff.full_name ?? staff.id,
    roleContext,
  };
}

/** Guard: returns false when View-As is active (blocks mutations). */
export async function assertNotViewAs(): Promise<boolean> {
  const cookieStore = await cookies();
  return !cookieStore.get(VIEW_AS_COOKIE)?.value;
}
