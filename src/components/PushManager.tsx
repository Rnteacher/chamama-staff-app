"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  subscribeToPushAction,
  unsubscribeFromPushAction,
  sendTestPushAction,
} from "@/lib/actions/push";
import {
  ensurePushSubscription,
} from "@/components/PushBanner";

type Status =
  | "loading"
  | "unsupported"
  | "no-vapid"
  | "denied"
  | "not-subscribed"
  | "subscribed";

export default function PushManager() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const check = setTimeout(() => {
      void (async () => {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
          setStatus("unsupported");
          return;
        }
        if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
          setStatus("no-vapid");
          return;
        }
        if (Notification.permission === "denied") {
          setStatus("denied");
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          // keep the server record fresh
          const json = sub.toJSON();
          await subscribeToPushAction({
            endpoint: sub.endpoint,
            p256dh: json.keys!.p256dh!,
            auth: json.keys!.auth!,
            userAgent: navigator.userAgent.slice(0, 300),
          });
          setStatus("subscribed");
        } else {
          setStatus("not-subscribed");
        }
      })().catch(() => setStatus("unsupported"));
    }, 0);
    return () => clearTimeout(check);
  }, []);

  async function subscribe() {
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "not-subscribed");
        return;
      }
      await ensurePushSubscription();
      setStatus("subscribed");
      router.refresh();
    } catch {
      setMessage("הרישום להתראות נכשל. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        await unsubscribeFromPushAction({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setStatus("not-subscribed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      await sendTestPushAction();
      setMessage("נשלחה התראת בדיקה. אם לא התקבלה — בדקו הרשאות במערכת.");
    } finally {
      setBusy(false);
    }
  }

  const descriptions: Record<Status, string> = {
    loading: "בודקים מצב התראות…",
    unsupported:
      "הדפדפן הזה לא תומך בהתראות. ניתן להמשיך להשתמש במערכת כרגיל — עדכונים חדשים יופיעו בכניסה הבאה.",
    "no-vapid":
      "התראות אינן מוגדרות בשרת (חסרים מפתחות VAPID). המערכת עצמה עובדת כרגיל.",
    denied:
      "ההתראות חסומות בהגדרות הדפדפן. המערכת ממשיכה לעבוד כרגיל; אפשר לאפשר מחדש דרך הגדרות האתר.",
    "not-subscribed": "ההתראות כבויות במכשיר זה.",
    subscribed: "ההתראות פועלות במכשיר זה.",
  };

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p aria-live="polite" className="text-sm leading-6 text-muted">
        {descriptions[status]}
      </p>
      <p className="mt-1 text-xs text-muted">
        ההתראה מודיעה שהתקבל עדכון חדש — ללא תוכן ההודעה עצמה.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {(status === "not-subscribed" || status === "denied") && (
          <button
            type="button"
            onClick={subscribe}
            disabled={busy}
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-ink disabled:opacity-60"
          >
            {busy ? "מפעילים…" : "הפעלת התראות"}
          </button>
        )}
        {status === "subscribed" && (
          <>
            <button
              type="button"
              onClick={sendTest}
              disabled={busy}
              className="rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-bold disabled:opacity-60"
            >
              התראת בדיקה
            </button>
            <button
              type="button"
              onClick={unsubscribe}
              disabled={busy}
              className="rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-bold text-danger disabled:opacity-60"
            >
              כיבוי התראות במכשיר זה
            </button>
          </>
        )}
      </div>

      {message && (
        <p role="status" className="mt-2 text-sm font-semibold">
          {message}
        </p>
      )}
    </div>
  );
}
