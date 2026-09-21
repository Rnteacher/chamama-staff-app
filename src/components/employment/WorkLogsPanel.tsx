"use client";

import { useActionState, useState } from "react";
import {
  upsertWorkLogAction,
  deleteWorkLogAction,
} from "@/lib/actions/employment";
import {
  deriveDurationMinutes,
  formatHoursLabel,
} from "@/lib/employment";

export interface WorkLogRow {
  id: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number;
  note: string | null;
}

function todayISO(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function timeSlice(t: string | null): string {
  return t ? t.slice(0, 5) : "";
}

/**
 * Actual-hours entry — the compact mobile workflow:
 * student → date → start/end (or duration) → save.
 * The canonical duration is derived from start/end server-side.
 */
export default function WorkLogsPanel({
  placementId,
  studentId,
  logs,
  canManage,
}: {
  placementId: string;
  studentId: string;
  logs: WorkLogRow[];
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState(upsertWorkLogAction, null);
  const [delState, delAction, delPending] = useActionState(deleteWorkLogAction, null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const derived =
    startTime !== "" && endTime !== "" ? deriveDurationMinutes(startTime, endTime) : null;
  const durationInvalid = startTime !== "" && endTime !== "" && derived === null;

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="font-extrabold">שעות עבודה בפועל</h2>

      {canManage && (
        <form action={formAction} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="placementId" value={placementId} />
          <input type="hidden" name="studentId" value={studentId} />
          {editingId && <input type="hidden" name="workLogId" value={editingId} />}

          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="block">
              תאריך
              <input
                type="date"
                name="workDate"
                required
                defaultValue={todayISO()}
                className="mr-1 rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="block">
              שעת התחלה
              <input
                type="time"
                name="startTime"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                dir="ltr"
                className="mr-1 rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="block">
              שעת סיום
              <input
                type="time"
                name="endTime"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                dir="ltr"
                className="mr-1 rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="block">
              או משך (דקות)
              <input
                type="number"
                name="durationMinutes"
                min={1}
                max={720}
                dir="ltr"
                placeholder={derived ? String(derived) : "לא חובה"}
                disabled={startTime !== "" && endTime !== ""}
                className="mr-1 w-28 rounded-xl border border-line px-3 py-2 disabled:opacity-50"
              />
            </label>
          </div>

          {durationInvalid && (
            <p className="text-xs font-semibold text-danger">
              שעת הסיום חייבת להיות אחרי שעת ההתחלה
            </p>
          )}
          {!durationInvalid && derived !== null && (
            <p className="text-xs font-semibold text-brand-dark">
              משך מחושב: {formatHoursLabel(derived)}
            </p>
          )}

          <label className="block text-sm">
            הערה (לא חובה)
            <input
              name="note"
              maxLength={500}
              className="mt-1 w-full rounded-xl border border-line px-3 py-2"
            />
          </label>

          {state && !state.ok && (
            <p role="alert" className="text-sm font-semibold text-danger">{state.error}</p>
          )}
          {state?.ok && (
            <p role="status" className="text-sm font-semibold text-brand-dark">
              השעות נרשמו
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending || durationInvalid}
              className="rounded-full bg-ink px-5 py-2.5 text-sm font-extrabold text-white disabled:opacity-60"
            >
              {pending ? "שומרים…" : editingId ? "שמירת שינויים" : "רישום שעות"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setStartTime("");
                  setEndTime("");
                }}
                className="rounded-full border border-line px-4 py-2.5 text-sm font-bold"
              >
                ביטול עריכה
              </button>
            )}
          </div>
        </form>
      )}

      {logs.length === 0 ? (
        <p className="mt-3 text-sm text-muted">טרם נרשמו שעות עבודה.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          {logs.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 pb-1.5 last:border-0"
            >
              <span className="flex items-baseline gap-2">
                <span className="font-bold" dir="ltr">{l.work_date}</span>
                <span dir="ltr" className="text-muted">
                  {l.start_time ? `${timeSlice(l.start_time)}–${timeSlice(l.end_time)}` : ""}
                </span>
                <span className="text-xs text-muted">{l.note}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="font-bold">{formatHoursLabel(l.duration_minutes)}</span>
                {canManage && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(l.id);
                        setStartTime(timeSlice(l.start_time));
                        setEndTime(timeSlice(l.end_time));
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                      className="rounded-full border border-line px-2.5 py-1 text-xs font-bold"
                    >
                      עריכה
                    </button>
                    <form action={delAction}>
                      <input type="hidden" name="workLogId" value={l.id} />
                      <input type="hidden" name="studentId" value={studentId} />
                      <button
                        type="submit"
                        disabled={delPending}
                        className="rounded-full border border-line px-2.5 py-1 text-xs font-bold text-danger disabled:opacity-60"
                      >
                        מחיקה
                      </button>
                    </form>
                  </>
                )}
              </span>
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
