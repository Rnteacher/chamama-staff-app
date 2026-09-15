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

/** Store this device's push subscription for the signed-in user. */
export async function subscribeToPushAction(
  input: z.input<typeof subscribePushSchema>
): Promise<ActionState> {
  const parsed = subscribePushSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
  const me = await requireMe();
  const supabase = await createClient();

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: me.userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.p256dh,
      auth: parsed.data.auth,
      user_agent: parsed.data.userAgent ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" }
  );
  if (error) return { ok: false, error: "שמירת המנוי נכשלה" };
  return { ok: true };
}

/** Remove this device's push subscription. */
export async function unsubscribeFromPushAction(
  input: z.input<typeof unsubscribePushSchema>
): Promise<ActionState> {
  const parsed = unsubscribePushSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "קלט לא תקין" };
  const me = await requireMe();
  const supabase = await createClient();

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", me.userId)
    .eq("endpoint", parsed.data.endpoint);
  if (error) return { ok: false, error: "מחיקת המנוי נכשלה" };
  return { ok: true };
}

/** Sends a generic, content-free test notification to the current user. */
export async function sendTestPushAction(): Promise<ActionState> {
  const me = await requireMe();
  await sendPushToUsers([me.userId], {
    title: "חממה",
    body: "זו התראת בדיקה — ההתראות פועלות",
    url: "/",
  });
  return { ok: true };
}
