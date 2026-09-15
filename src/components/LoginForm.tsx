"use client";

import { useState, useTransition } from "react";
import { createBrowserClient } from "@/lib/supabase/browser";

export default function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const emailLoginEnabled =
    process.env.NEXT_PUBLIC_ENABLE_EMAIL_LOGIN === "true";

  function signInWithGoogle() {
    setError(null);
    startTransition(async () => {
      const supabase = createBrowserClient();
      const next = new URLSearchParams(window.location.search).get("next");
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback${
            next ? `?next=${encodeURIComponent(next)}` : ""
          }`,
        },
      });
      if (error) setError("שגיאה בהתחברות. נסו שוב.");
    });
  }

  async function signInWithEmail(formData: FormData) {
    setError(null);
    const supabase = createBrowserClient();
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setError("אימייל או סיסמה שגויים");
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next && next.startsWith("/") ? next : "/");
  }

  return (
    <div className="w-full flex flex-col gap-3">
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={pending}
        className="w-full rounded-full bg-ink text-white font-bold text-base px-6 py-3.5 flex items-center justify-center gap-3 disabled:opacity-60"
      >
        <GoogleIcon />
        {pending ? "מתחברים…" : "התחברות עם Google"}
      </button>

      {emailLoginEnabled && (
        <details className="w-full text-sm text-muted">
          <summary className="cursor-pointer select-none py-2 text-center">
            כניסה לבדיקות באמצעות אימייל וסיסמה (סביבת פיתוח בלבד)
          </summary>
          <form
            action={signInWithEmail}
            className="mt-2 flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4"
          >
            <label className="text-right" htmlFor="email">
              אימייל
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="rounded-xl border border-line px-3 py-2.5 bg-white"
            />
            <label className="text-right" htmlFor="password">
              סיסמה
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="rounded-xl border border-line px-3 py-2.5 bg-white"
            />
            <button
              type="submit"
              className="mt-1 rounded-full bg-brand text-ink font-bold px-4 py-2.5"
            >
              כניסה
            </button>
          </form>
        </details>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger text-center">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  );
}
