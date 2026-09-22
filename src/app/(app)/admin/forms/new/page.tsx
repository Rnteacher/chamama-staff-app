"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formCreateAction } from "@/lib/actions/forms";
import type { ActionState } from "@/lib/actions/messages";

export default function NewFormPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await formCreateAction(null, fd);
      if (!res.ok) { setError(res.error); return; }
      router.push("/admin/forms");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/admin/forms" className="text-sm font-medium text-muted hover:text-ink">‹ חזרה לטפסים</Link>
      <h1 className="text-xl font-extrabold">טופס חדש</h1>
      <form
        onSubmit={(e) => { e.preventDefault(); submit(new FormData(e.currentTarget)); }}
        className="flex max-w-md flex-col gap-3 rounded-2xl border border-line bg-surface p-5"
      >
        <label className="block text-sm font-semibold">מזהה טופס (אנגלית, ללא רווחים)
          <input name="formKey" required dir="ltr" pattern="[a-z0-9_]{3,60}"
            placeholder="mid_feedback"
            className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
        </label>
        <label className="block text-sm font-semibold">שם הטופס
          <input name="name" required placeholder="משוב אמצע פרויקט"
            className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
        </label>
        <label className="block text-sm font-semibold">תיאור
          <input name="description" className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
        </label>
        <label className="block text-sm font-semibold">קהל יעד
          <select name="audience" className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2">
            <option value="staff">צוות (התחברות)</option>
            <option value="public">ציבור (קישור מוגן)</option>
          </select>
        </label>
        <label className="block text-sm font-semibold">קטגוריה בפיד
          <select name="feedCategory" className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2">
            <option value="hidden">מוסתר</option>
            <option value="ongoing">עדכון שוטף</option>
            <option value="project">עדכון פרויקט</option>
          </select>
        </label>
        <input type="hidden" name="schema" value='{"version":"1","steps":[{"id":"s1","title":"שאלות"}],"fields":[]}' />
        {error && <p role="alert" className="text-sm font-bold text-danger">{error}</p>}
        <button type="submit" disabled={pending}
          className="rounded-full bg-brand px-6 py-3 font-extrabold text-ink disabled:opacity-60">
          {pending ? "יוצר…" : "יצירה ופתיחת בונה"}
        </button>
      </form>
    </div>
  );
}
