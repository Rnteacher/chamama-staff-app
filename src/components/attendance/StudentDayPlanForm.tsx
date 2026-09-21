"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  upsertStudentDayPlanAction,
  deleteStudentDayPlanAction,
} from "@/lib/actions/attendance";
import {
  EFFECTIVE_STATUS_LABELS,
  formatPlanHe,
  normalizeDbTime,
  type EffectiveSchoolStatus,
} from "@/lib/attendance";

/**
 * "הגעה/יציאה מתוכננת" — planned-day exceptions on the student page.
 * One plan row per student/date; secondary to actual attendance and never
 * creating one (the server treats them as entirely separate models).
 */
export default function StudentDayPlanForm({
  studentId,
  date,
  effective,
  canManage,
  studentName,
}: {
  studentId: string;
  date: string;
  effective: EffectiveSchoolStatus;
  canManage: boolean;
  studentName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [open, setOpen] = useState(false);

  const planLine = formatPlanHe(effective);
  const hasPlan = Boolean(effective.plan_id);

  function save(fd: FormData) {
    setError(null);
    setOk(false);
    fd.set("studentId", studentId);
    fd.set("date", date);
    startTransition(async () => {
      const res = await upsertStudentDayPlanAction(null, fd);
      if (res.ok) {
        setOk(true);
        setOpen(false);
        router.refresh();
      } else setError(res.error);
    });
  }

  function remove() {
    setError(null);
    const fd = new FormData();
    fd.set("studentId", studentId);
    fd.set("date", date);
    startTransition(async () => {
      const res = await deleteStudentDayPlanAction(null, fd);
      if (res.ok) {
        setOk(true);
        router.refresh();
      } else setError(res.error);
    });
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold">הגעה/יציאה מתוכננת</h2>
        {canManage && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted"
          >
            {hasPlan ? "עריכה" : "הוספה"}
          </button>
        )}
      </div>

      <p className="mt-2 text-sm text-muted">
        סטטוס נוכחות אפקטיבי היום:{" "}
        <span className="font-bold text-ink">{EFFECTIVE_STATUS_LABELS[effective.status]}</span>
        {effective.status === "late" && effective.arrival_time && (
          <> · הגיע/ה ב־<span dir="ltr">{normalizeDbTime(effective.arrival_time)}</span></>
        )}
      </p>
      {planLine && (
        <p className="mt-2 rounded-xl bg-brand-soft px-3 py-2 text-sm font-semibold">📋 {planLine}</p>
      )}

      {ok && <p className="mt-2 text-xs font-bold text-emerald-700">נשמר</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {open && (
        <form
          action={(fd) => save(fd)}
          className="mt-3 flex flex-col gap-3 border-t border-line pt-3"
        >
          <p className="text-xs text-muted">
            תוכנית היום עבור {studentName} — היא מוצגת לצוות אך אינה משנה את הדיווח בפועל.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-bold">
              הגעה מתוכננת
              <input
                type="time"
                name="lateArrival"
                dir="ltr"
                defaultValue={normalizeDbTime(effective.planned_late_arrival_time) ?? ""}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="text-sm font-bold">
              יציאה מתוכננת
              <input
                type="time"
                name="earlyDeparture"
                dir="ltr"
                defaultValue={normalizeDbTime(effective.planned_early_departure_time) ?? ""}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2"
              />
            </label>
          </div>
          <label className="text-sm font-bold">
            הסבר (רשות)
            <input
              type="text"
              name="reason"
              maxLength={300}
              defaultValue={effective.plan_reason ?? ""}
              placeholder="למשל: בדיקת רופא"
              className="mt-1 w-full rounded-xl border border-line px-3 py-2"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-ink px-4 py-2 text-sm font-extrabold text-white disabled:opacity-60"
            >
              שמירה
            </button>
            {hasPlan && (
              <button
                type="button"
                disabled={pending}
                onClick={remove}
                className="rounded-full border border-line px-4 py-2 text-sm font-bold text-danger disabled:opacity-60"
              >
                הסרת התוכנית
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
