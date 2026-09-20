"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export async function enterViewAsAction(
  staffId: string,
  roleContext: string
): Promise<{ ok: boolean; error?: string }> {
  const me = await requireMe();
  if (!hasRole(me, "super_admin")) {
    return { ok: false, error: "רק מנהל מערכת יכול להשתמש בצפייה כ־" };
  }
  const supabase = await createClient();
  const { data: staff } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("id", staffId)
    .eq("is_active", true)
    .maybeSingle();
  if (!staff) return { ok: false, error: "איש הצוות לא נמצא או אינו פעיל" };

  const cookieStore = await cookies();
  cookieStore.set("view_as_staff", staffId, {
    httpOnly: true, sameSite: "lax", maxAge: 2 * 60 * 60, path: "/",
  });
  cookieStore.set("view_as_role", roleContext, {
    httpOnly: true, sameSite: "lax", maxAge: 2 * 60 * 60, path: "/",
  });

  const admin = createAdminClient();
  await admin.from("audit_logs").insert({
    actor_staff_id: me.staffId,
    action: "view_as_enter",
    entity_type: "staff_member",
    entity_id: staffId,
    metadata: { role_context: roleContext },
  });

  revalidatePath("/");
  return { ok: true };
}

export async function exitViewAsAction(): Promise<void> {
  const me = await requireMe();
  const cookieStore = await cookies();
  const wasActive = Boolean(cookieStore.get("view_as_staff")?.value);
  cookieStore.delete("view_as_staff");
  cookieStore.delete("view_as_role");
  if (wasActive && me.staffId) {
    const admin = createAdminClient();
    await admin.from("audit_logs").insert({
      actor_staff_id: me.staffId,
      action: "view_as_exit",
      entity_type: "staff_member",
      entity_id: me.staffId,
      metadata: {},
    });
  }
  revalidatePath("/");
}
