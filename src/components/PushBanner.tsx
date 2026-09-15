"use client";

import { useEffect, useState } from "react";
import { subscribeToPushAction } from "@/lib/actions/push";

/** Registers/reuses the push subscription and stores it for this user. */
export async function ensurePushSubscription(): Promise<void> {
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
  const json = sub.toJSON();
  const res = await subscribeToPushAction({
    endpoint: sub.endpoint,
    p256dh: json.keys!.p256dh!,
    auth: json.keys!.auth!,
    userAgent: navigator.userAgent.slice(0, 300),
  });
  if (!res.ok) throw new Error(res.error);
}

/**
 * Dismissable home-screen banner prompting to enable push notifications.
 * Auto-hides once subscribed or dismissed (persisted in localStorage).
 * The app is fully usable with notifications disabled — this is only an
 * opt-in convenience.
 */
export default function PushBanner() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const decide = setTimeout(() => {
      if (localStorage.getItem("push-banner-dismissed") === "1") return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return;
      if (Notification.permission === "granted") {
        // already granted: silently keep the subscription fresh
        void ensurePushSubscription().catch(() => undefined);
        return;
      }
      if (Notification.permission === "denied") return;
      setVisible(true);
    }, 0);
    return () => clearTimeout(decide);
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setVisible(false);
        return;
      }
      await ensurePushSubscription();
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
