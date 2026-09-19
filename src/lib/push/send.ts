import "server-only";

import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/server";
import { hasVapidConfig } from "@/lib/server-env";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/**
 * Send a push notification to every subscription of the given staff members.
 *
 * Returns a per-staff delivery result: true = done (delivered, no
 * subscriptions, or only permanently-invalid subscriptions), false = a
 * retryable failure occurred (transient provider error) and the caller may
 * redeliver later. Failures are also logged; this function never throws.
 */
export async function sendPushToUsers(
  staffIds: string[],
  payload: PushPayload
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  if (staffIds.length === 0) return results;
  if (!hasVapidConfig()) {
    await logPushFailure(null, "vapid_not_configured", payload.url);
    for (const id of staffIds) results[id] = false; // not configured → retryable
    return results;
  }

  try {
    // hasVapidConfig() was checked above — all three values exist.
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT!,
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!
    );
  } catch {
    await logPushFailure(null, "vapid_setup_error", payload.url);
    for (const id of staffIds) results[id] = false; // not configured → retryable
    return results;
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    await logPushFailure(null, "service_role_not_configured", payload.url);
    for (const id of staffIds) results[id] = false;
    return results;
  }

  const { data: subscriptions, error } = await admin
    .from("push_subscriptions")
    .select("id, staff_id, endpoint, p256dh, auth")
    .in("staff_id", staffIds);
  if (error || !subscriptions) {
    await logPushFailure(null, "subscriptions_query_error", payload.url);
    for (const id of staffIds) results[id] = false;
    return results;
  }

  // group subscriptions per staff member
  const byStaff = new Map<string, typeof subscriptions>();
  for (const id of staffIds) byStaff.set(id, []);
  for (const sub of subscriptions) {
    byStaff.get(sub.staff_id)?.push(sub);
  }

  const payloadStr = JSON.stringify(payload);

  await Promise.allSettled(
    staffIds.map(async (staffId) => {
      const subs = byStaff.get(staffId) ?? [];
      if (subs.length === 0) {
        // nothing to deliver — treat as done (no endless retries)
        results[staffId] = true;
        return;
      }
      let hadSuccess = false;
      let retryableFailure = false;
      await Promise.allSettled(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
              },
              payloadStr,
              { TTL: 3600, headers: { Urgency: "high" } }
            );
            hadSuccess = true;
          } catch (err) {
            const statusCode =
              typeof err === "object" && err && "statusCode" in err
                ? Number((err as { statusCode: unknown }).statusCode)
                : null;
            if (statusCode === 404 || statusCode === 410) {
              // subscription permanently gone — remove it
              await admin
                .from("push_subscriptions")
                .delete()
                .eq("id", sub.id);
            } else {
              retryableFailure = true;
              await logPushFailure(sub.id, `http_${statusCode ?? "unknown"}`, payload.url);
            }
          }
        })
      );
      results[staffId] = hadSuccess || !retryableFailure;
    })
  );

  return results;
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
