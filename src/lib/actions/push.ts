"use server";

import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  subscribePushSchema,
  unsubscribePushSchema,
} from "@/lib/validation";
import { z } from "zod";
import type { ActionState } from "@/lib/actions/messages";
import { sendPushToUsers } from "@/lib/push/send";

/** Store this device's push subscription for the signed-in staff identity. */
export async function subscribeToPushAction(
  input: z.input<typeof subscribePushSchema>
): Promise<ActionState> {
  const parsed = subscribePushSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
  const supabase = await createClient();

  // Saves this browser's subscription for the caller; if the same browser
  // subscription is still registered to another staff member (previous
  // sign-in on this device), ownership moves to the caller atomically.
  const { data: status, error } = await supabase.rpc(
    "claim_push_subscription",
    {
      p_endpoint: parsed.data.endpoint,
      p_p256dh: parsed.data.p256dh,
      p_auth: parsed.data.auth,
      p_user_agent: parsed.data.userAgent ?? null,
    }
  );
  if (error || (status !== "ok" && status !== "transferred")) {
    return { ok: false, error: "שמירת המנוי נכשלה" };
  }
  return { ok: true };
}

/** Remove this device's push subscription. */
export async function unsubscribeFromPushAction(
  input: z.input<typeof unsubscribePushSchema>
): Promise<ActionState> {
  const parsed = unsubscribePushSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
  const supabase = await createClient();

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("staff_id", me.staffId)
    .eq("endpoint", parsed.data.endpoint);
  if (error) return { ok: false, error: "מחיקת המנוי נכשלה" };
  return { ok: true };
}

/** Sends a generic, content-free test notification to the current user. */
export async function sendTestPushAction(): Promise<ActionState> {
  const me = await requireMe();
  if (!me.staffId) return { ok: false, error: "אין זהות צוות מקושרת" };
  await sendPushToUsers([me.staffId], {
    title: "חממה",
    body: "זו התראת בדיקה — ההתראות פועלות",
    url: "/",
  });
  return { ok: true };
}
