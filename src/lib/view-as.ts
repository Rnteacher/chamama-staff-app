import "server-only";

import { cache } from "react";
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

const INACTIVE: ViewAsState = {
  active: false,
  staffId: null,
  staffName: null,
  roleContext: null,
};

/**
 * Read the current View-As state (server-side only, read-only).
 * Request-scoped (React cache): layout + page share one resolution.
 */
export const getViewAsState = cache(async (): Promise<ViewAsState> => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(VIEW_AS_COOKIE)?.value ?? null;
  const staffId = raw && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;

  // The target lookup is an RLS-scoped read that does not depend on the
  // identity check, so it starts concurrently — but its result is honoured
  // ONLY after the caller is verified as super_admin below.
  const targetP = staffId
    ? createClient().then((supabase) =>
        supabase
          .from("profiles")
          .select("id, full_name")
          .eq("id", staffId)
          .eq("is_active", true)
          .maybeSingle()
      )
    : null;

  const me = await requireMe();
  if (!me || !hasRole(me, "super_admin") || !staffId || !targetP) {
    return INACTIVE;
  }
  const { data: staff } = await targetP;
  if (!staff) return INACTIVE;
  const roleContext = cookieStore.get("view_as_role")?.value ?? "staff";
  return {
    active: true,
    staffId: staff.id,
    staffName: staff.full_name ?? staff.id,
    roleContext,
  };
});

/** Guard: returns false when View-As is active (blocks mutations). */
export async function assertNotViewAs(): Promise<boolean> {
  const cookieStore = await cookies();
  return !cookieStore.get(VIEW_AS_COOKIE)?.value;
}
