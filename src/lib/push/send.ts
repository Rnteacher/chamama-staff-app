import "server-only";

import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/server";
import { env, hasVapidConfig } from "@/lib/env";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/**
 * Send a push notification to every subscription of the given users.
 * Failures are logged (never thrown): the database message is the source of
 * truth, notification delivery must not break message creation.
 * Invalid/expired subscriptions (404/410) are removed.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<void> {
  if (userIds.length === 0) return;
  if (!hasVapidConfig()) {
    await logPushFailure(null, "vapid_not_configured", payload.url);
    return;
  }

  try {
    webpush.setVapidDetails(
      env.VAPID_SUBJECT,
      env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY
    );
  } catch {
    await logPushFailure(null, "vapid_setup_error", payload.url);
    return;
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    await logPushFailure(null, "service_role_not_configured", payload.url);
    return;
  }

  const { data: subscriptions, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (error || !subscriptions) {
    await logPushFailure(null, "subscriptions_query_error", payload.url);
    return;
  }

  const payloadStr = JSON.stringify(payload);

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payloadStr,
          { TTL: 3600, headers: { Urgency: "high" } }
        );
      } catch (err) {
        const statusCode =
          typeof err === "object" && err && "statusCode" in err
            ? Number((err as { statusCode: unknown }).statusCode)
            : null;
        if (statusCode === 404 || statusCode === 410) {
          // subscription gone — remove it
          await admin
            .from("push_subscriptions")
            .delete()
            .eq("id", sub.id);
        } else {
          await logPushFailure(sub.id, `http_${statusCode ?? "unknown"}`, payload.url);
        }
      }
    })
  );
}

async function logPushFailure(
  subscriptionId: string | null,
  reason: string,
  url: string
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("audit_logs").insert({
      action: "push_send_failed",
      entity_type: "push_subscription",
      entity_id: subscriptionId,
      metadata: { reason, url },
    });
  } catch {
    // never break the message flow because of logging
  }
}
