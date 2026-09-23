"use client";

import { useEffect, useState } from "react";
import { subscribeToPushAction } from "@/lib/actions/push";
import type { ActionState } from "@/lib/actions/messages";

// Last successful server save of this device's subscription (per browser).
const PUSH_SYNC_KEY = "push-subscription-synced";
// An unchanged subscription is re-saved at most this often.
const PUSH_RESYNC_MS = 24 * 60 * 60 * 1000;

interface PushSyncRecord {
  staffId: string;
  /** SHA-256 of endpoint + keys — the keys themselves are never stored */
  fingerprint: string;
  at: number;
}

async function subscriptionFingerprint(sub: PushSubscription): Promise<string> {
  const json = sub.toJSON();
  const data = new TextEncoder().encode(
    [sub.endpoint, json.keys?.p256dh ?? "", json.keys?.auth ?? ""].join("|")
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** Saves this device's subscription for the signed-in staff member. */
async function saveSubscription(
  sub: PushSubscription,
  staffId: string | null
): Promise<ActionState> {
  const json = sub.toJSON();
  const res = await subscribeToPushAction({
    endpoint: sub.endpoint,
    p256dh: json.keys!.p256dh!,
    auth: json.keys!.auth!,
    userAgent: navigator.userAgent.slice(0, 300),
  });
  if (res.ok && staffId) {
    try {
      const record: PushSyncRecord = {
        staffId,
        fingerprint: await subscriptionFingerprint(sub),
        at: Date.now(),
      };
      localStorage.setItem(PUSH_SYNC_KEY, JSON.stringify(record));
    } catch {
      // storage unavailable: the next page load simply re-saves
    }
  }
  return res;
}

/**
 * Background refresh of an existing subscription on page load. The server
 * record is re-saved only when something changed (another staff member on
 * this device, a new endpoint or keys) or the last save is older than a day —
 * not on every page load.
 */
export async function refreshPushSubscription(
  sub: PushSubscription,
  staffId: string | null
): Promise<void> {
  try {
    const last = JSON.parse(
      localStorage.getItem(PUSH_SYNC_KEY) ?? "null"
    ) as PushSyncRecord | null;
    if (
      staffId &&
      last &&
      last.staffId === staffId &&
      Date.now() - last.at < PUSH_RESYNC_MS &&
      last.fingerprint === (await subscriptionFingerprint(sub))
    ) {
      return;
    }
  } catch {
    // unreadable record: fall through and re-save
  }
  await saveSubscription(sub, staffId);
}

/** Registers/reuses the push subscription and stores it for this user. */
export async function ensurePushSubscription(
  staffId: string | null
): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const sub =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!
      ),
    }));
  const res = await saveSubscription(sub, staffId);
  if (!res.ok) throw new Error(res.error);
}

/**
 * Dismissable home-screen banner prompting to enable push notifications.
 * Auto-hides once subscribed or dismissed (persisted in localStorage).
 * The app is fully usable with notifications disabled — this is only an
 * opt-in convenience.
 */
export default function PushBanner({
  staffId,
}: {
  staffId: string | null;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const decide = setTimeout(() => {
      if (localStorage.getItem("push-banner-dismissed") === "1") return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return;
      if (Notification.permission === "granted") {
        // already granted: silently keep the subscription fresh
        void (async () => {
          const registration = await navigator.serviceWorker.ready;
          const existing = await registration.pushManager.getSubscription();
          if (existing) await refreshPushSubscription(existing, staffId);
          else await ensurePushSubscription(staffId);
        })().catch(() => undefined);
        return;
      }
      if (Notification.permission === "denied") return;
      setVisible(true);
    }, 0);
    return () => clearTimeout(decide);
  }, [staffId]);

  async function enable() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setVisible(false);
        return;
      }
      await ensurePushSubscription(staffId);
      setVisible(false);
    } catch {
      // keep banner if registration failed
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    localStorage.setItem("push-banner-dismissed", "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="הפעלת התראות"
      className="fixed inset-x-0 bottom-[68px] z-20 px-4"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-2xl border border-line bg-surface p-3 shadow-lg">
        <p className="flex-1 text-sm leading-5">
          רוצים לדעת מיד כשמתקבל עדכון חדש?
          <br />
          <span className="text-muted text-xs">
            ההתראה לא מציגה תוכן רגיש.
          </span>
        </p>
        <button
          type="button"
          onClick={enable}
          disabled={busy}
          className="rounded-full bg-brand px-4 py-2 text-sm font-bold text-ink disabled:opacity-60"
        >
          {busy ? "מפעילים…" : "הפעלה"}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="סגירת ההצעה"
          className="rounded-full px-2 py-2 text-muted hover:bg-bg"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function urlBase64ToUint8Array(
  base64String: string
): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
