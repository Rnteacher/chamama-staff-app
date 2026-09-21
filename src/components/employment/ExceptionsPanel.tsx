"use client";

import { useActionState, useState } from "react";
import {
  upsertEmploymentExceptionAction,
  deleteEmploymentExceptionAction,
} from "@/lib/actions/employment";
import { EXCEPTION_KIND_LABELS } from "@/lib/employment";

export interface ExceptionRow {
  id: string;
  work_date: string;
  kind: "add" | "cancel" | "modify";
  start_time: string | null;
  end_time: string | null;
}

function timeSlice(t: string | null): string {
  return t ? t.slice(0, 5) : "";
}

/**
 * Date-specific work-plan exceptions: add a work day, cancel a normal work
 * day, or change the hours of a specific date.
 */
export default function ExceptionsPanel({
  placementId,
  studentId,
  exceptions,
  canManage,
}: {
  placementId: string;
  studentId: string;
  exceptions: ExceptionRow[];
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    upsertEmploymentExceptionAction,
    null
  );
  const [delState, delAction, delPending] = useActionState(
    deleteEmploymentExceptionAction,
    null
  );
  const [kind, setKind] = useState<"add" | "cancel" | "modify">("add");

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="font-extrabold">חריגות לתאריך ספציפי</h2>
      <p className="mt-1 text-xs text-muted">
        עבודה בתאריך חריג, ביטול יום עבודה רגיל או שעות שונות ליום מסוים.
      </p>

      {canManage && (
        <form action={formAction} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="placementId" value={placementId} />
          <input type="hidden" name="studentId" value={studentId} />

          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="block">
              סוג
              <select
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
                className="mr-1 rounded-xl border border-line bg-white px-2 py-2"
              >
                <option value="add">עבודה בתאריך חריג</option>
                <option value="cancel">ביטול יום עבודה</option>
                <option value="modify">שעות שונות</option>
              </select>
            </label>
            <label className="block">
              תאריך
              <input
                type="date"
                name="workDate"
                required
                className="mr-1 rounded-xl border border-line px-3 py-2"
              />
            </label>
            {kind !== "cancel" && (
              <>
                <label className="block">
                  משעה
                  <input
                    type="time"
                    name="startTime"
                    required
                    dir="ltr"
                    className="mr-1 rounded-xl border border-line px-3 py-2"
                  />
                </label>
                <label className="block">
                  עד שעה
                  <input
                    type="time"
                    name="endTime"
                    required
                    dir="ltr"
                    className="mr-1 rounded-xl border border-line px-3 py-2"
                  />
                </label>
              </>
            )}
          </div>

          {state && !state.ok && (
            <p role="alert" className="text-sm font-semibold text-danger">{state.error}</p>
          )}
          {state?.ok && (
            <p role="status" className="text-sm font-semibold text-brand-dark">החריגה נשמרה</p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="self-start rounded-full bg-ink px-5 py-2.5 text-sm font-extrabold text-white disabled:opacity-60"
          >
            {pending ? "שומרים…" : "שמירת חריגה"}
          </button>
        </form>
      )}

      {exceptions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">אין חריגות בתקופה הקרובה.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          {exceptions.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 pb-1.5 last:border-0"
            >
              <span className="flex items-baseline gap-2">
                <span className="font-bold" dir="ltr">{e.work_date}</span>
                <span className="text-xs font-semibold">{EXCEPTION_KIND_LABELS[e.kind]}</span>
                {e.kind !== "cancel" && (
                  <span dir="ltr" className="text-muted">
                    {timeSlice(e.start_time)}–{timeSlice(e.end_time)}
                  </span>
                )}
              </span>
              {canManage && (
                <form action={delAction}>
                  <input type="hidden" name="exceptionId" value={e.id} />
                  <input type="hidden" name="studentId" value={studentId} />
                  <button
                    type="submit"
                    disabled={delPending}
                    className="rounded-full border border-line px-2.5 py-1 text-xs font-bold text-danger disabled:opacity-60"
                  >
                    הסרה
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {delState && !delState.ok && (
        <p role="alert" className="mt-2 text-sm font-semibold text-danger">{delState.error}</p>
      )}
    </section>
  );
}
