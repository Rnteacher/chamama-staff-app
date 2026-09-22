"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  markSchoolAttendanceFastAction,
  clearSchoolAttendanceAction,
} from "@/lib/actions/attendance";
import { useOptimisticAttendance } from "@/components/attendance/useOptimisticAttendance";
import {
  ATTENDANCE_STATUS_LABELS,
  EFFECTIVE_STATUS_LABELS,
  formatPlanHe,
  jerusalemNowHHMM,
  normalizeDbTime,
  sortRosterForReopen,
  type EffectiveStatus,
  type SchoolAttendanceRosterRow,
} from "@/lib/attendance";

/**
 * MOBILE conversational school attendance — student by student, INSTANT.
 *
 * Every tap (נוכח/חסר/איחור) updates local state and advances to the next
 * student IMMEDIATELY (<100ms, no network wait). Persistence happens in a
 * background per-student queue through the fast server action (no
 * revalidate/refresh in the interaction loop; the route refreshes once when
 * the queue drains). Failed saves are visible ("לא נשמר") and retriable
 * without losing the chosen value or moving the flow backwards.
 *
 * Product rules (unchanged): absent-first reopen ordering, expected-work
 * students skipped with an explicit override, planned day exceptions shown
 * prominently but never as attendance choices.
 */
export default function SchoolAttendanceConversational({
  students,
  date,
  readOnly = false,
}: {
  students: SchoolAttendanceRosterRow[];
  studentsVersion?: number;
  date: string;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // optimistic local state + background save queue
  const api = useOptimisticAttendance(
    ({ studentId, status, arrivalTime }) =>
      markSchoolAttendanceFastAction({ studentId, date, status, arrivalTime }),
    () => startRefresh(() => router.refresh()) // once, when the queue drains
  );
  const { state: local, mark, retry, retryAll, pendingCount, errorIds } = api;

  // frozen session queue: absent-first order computed once per date —
  // re-sorting mid-flow would jump the mentor around; the drain-refresh
  // applies the canonical order on the next visit
  const [index, setIndex] = useState(0);
  const [queueDate, setQueueDate] = useState(date);
  const [queue, setQueue] = useState<SchoolAttendanceRosterRow[]>(() =>
    sortRosterForReopen(students)
  );
  if (queueDate !== date) {
    setQueueDate(date);
    setQueue(sortRosterForReopen(students));
    setIndex(0);
  }
  // students expected at work stay collapsed until explicitly overridden
  const [workRevealed, setWorkRevealed] = useState<Record<string, boolean>>({});
  // arrival-time editor value for the current card
  const [lateTime, setLateTime] = useState<string>(jerusalemNowHHMM());

  const resolved = useMemo(() => {
    const map = new Map<string, EffectiveStatus>();
    for (const s of queue) {
      const o = local[s.student_id];
      map.set(s.student_id, o ? o.status : s.effective.status);
    }
    return map;
  }, [queue, local]);

  const reported = queue.filter((s) => {
    const st = resolved.get(s.student_id);
    return st === "present" || st === "absent" || st === "late" || st === "expected_work";
  }).length;

  const current = queue[Math.min(index, queue.length - 1)];

  function advance() {
    setLateTime(jerusalemNowHHMM());
    setIndex((at) => {
      const nextIdx = queue.findIndex((s, i) => {
        if (i <= at) return false;
        const st = resolved.get(s.student_id);
        return st === "absent" || st === "late" || st === "unresolved";
      });
      return nextIdx === -1 ? Math.min(at + 1, queue.length - 1) : nextIdx;
    });
  }

  /** INSTANT: local update + advance happen now; the save is backgrounded. */
  function tap(studentId: string, status: "present" | "absent" | "late", arrivalTime?: string) {
    if (readOnly) return;
    setError(null);
    mark(studentId, status, status === "late" ? (arrivalTime ?? jerusalemNowHHMM()) : null);
    advance();
  }

  /** Edit the arrival time of the CURRENT student without advancing. */
  function updateArrival(studentId: string, arrivalTime: string) {
    if (readOnly || !/^\d{2}:\d{2}$/.test(arrivalTime)) return;
    mark(studentId, "late", arrivalTime);
  }

  function clearRecord(studentId: string) {
    if (readOnly) return;
    setError(null);
    const fd = new FormData();
    fd.set("studentId", studentId);
    fd.set("date", date);
    startRefresh(async () => {
      const res = await clearSchoolAttendanceAction(null, fd);
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (queue.length === 0) return null;

  const eff = current.effective;
  const curStatus = resolved.get(current.student_id) ?? eff.status;
  const curLocal = local[current.student_id];
  const revealed = Boolean(workRevealed[current.student_id]);
  const planLine = formatPlanHe(eff);

  return (
    <div className="flex flex-col gap-3" aria-label="נוכחות היום">
      <div className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm">
        <span className="font-bold">
          {reported} מתוך {queue.length} דווחו
        </span>
        <span className="flex items-center gap-2 text-xs">
          {errorIds.length > 0 && (
            <button
              type="button"
              onClick={retryAll}
              className="rounded-full border border-danger px-2.5 py-1 font-bold text-danger"
            >
              {errorIds.length} לא נשמרו — נסו שוב
            </button>
          )}
          {(pendingCount > 0 || isRefreshing) && (
            <span className="text-muted" aria-live="polite">
              {pendingCount > 0 ? "שומר…" : "מעדכן…"}
            </span>
          )}
          {error && <span className="text-danger">{error}</span>}
        </span>
      </div>

      {/* progress dots */}
      <div className="flex flex-wrap gap-1" aria-hidden="true">
        {queue.map((s) => {
          const o = local[s.student_id];
          const st = o ? o.status : s.effective.status;
          const cls =
            o?.save === "error" ? "bg-danger ring-2 ring-danger ring-offset-1"
            : o?.save === "saving" || o?.save === "pending" ? "bg-amber-400 animate-pulse"
            : st === "present" ? "bg-emerald-500"
            : st === "absent" ? "bg-danger"
            : st === "late" ? "bg-amber-500"
            : st === "expected_work" ? "bg-line"
            : "bg-line border border-dashed border-muted";
          return <span key={s.student_id} className={`h-2 w-6 rounded-full ${cls}`} />;
        })}
      </div>

      <div className="rounded-3xl border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-extrabold">
              {current.first_name} {current.last_name}
            </h3>
            {curStatus !== "unresolved" && (
              <p className="mt-0.5 text-sm text-muted">
                סטטוס נוכחי: <span className="font-bold text-ink">{EFFECTIVE_STATUS_LABELS[curStatus]}</span>
                {curStatus === "late" && (curLocal?.arrival ?? eff.arrival_time) && (
                  <> · הגיע/ה ב־<span dir="ltr">{curLocal?.arrival ?? normalizeDbTime(eff.arrival_time)}</span></>
                )}
              </p>
            )}
            {curLocal?.save === "error" && (
              <p className="mt-1 flex items-center gap-2 text-sm font-bold text-danger">
                לא נשמר
                <button
                  type="button"
                  onClick={() => retry(current.student_id)}
                  className="rounded-full border border-danger px-3 py-1 text-xs font-bold text-danger"
                >
                  נסו שוב
                </button>
              </p>
            )}
            {curLocal?.save === "saving" && (
              <p className="mt-1 text-xs text-muted">שומר…</p>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted">
            {index + 1}/{queue.length}
          </span>
        </div>

        {/* planned day exceptions — prominent, but NOT attendance choices */}
        {planLine && (
          <p className="mt-3 rounded-xl bg-brand-soft px-3 py-2 text-sm font-semibold text-ink">
            📋 {planLine}
          </p>
        )}

        {/* expected at work: compact card, skipped by default, explicit override */}
        {curStatus === "expected_work" && !revealed ? (
          <div className="mt-4 flex flex-col gap-2">
            <div className="rounded-2xl border border-line bg-bg px-4 py-4 text-center">
              <p className="text-base font-extrabold">בעבודה</p>
              {eff.workplace_name && (
                <p className="mt-0.5 text-xs text-muted">
                  {eff.workplace_name}
                  {normalizeDbTime(eff.work_start_time) &&
                    ` · ${normalizeDbTime(eff.work_start_time)}–${normalizeDbTime(eff.work_end_time)}`}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">אין צורך לדווח נוכחות</p>
            </div>
            {!readOnly && (
              <button
                type="button"
                onClick={() => setWorkRevealed((p) => ({ ...p, [current.student_id]: true }))}
                className="rounded-full border border-line px-4 py-2.5 text-sm font-bold text-muted"
              >
                הגיע/ה לבית הספר
              </button>
            )}
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-2">
              {(["present", "absent", "late"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  disabled={readOnly}
                  onClick={() => {
                    if (st === "late") {
                      // instant: save late with the current Jerusalem time
                      tap(current.student_id, "late", jerusalemNowHHMM());
                    } else {
                      tap(current.student_id, st);
                    }
                  }}
                  className={`min-h-[52px] rounded-2xl border px-3 py-3 text-base font-extrabold transition-colors ${
                    st === "present"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                      : st === "absent"
                        ? "border-red-300 bg-red-50 text-red-900"
                        : "border-amber-300 bg-amber-50 text-amber-900"
                  } disabled:opacity-60`}
                >
                  {ATTENDANCE_STATUS_LABELS[st]}
                </button>
              ))}
            </div>
            {/* arrival-time editor (correct a late time without advancing) */}
            {curStatus !== "expected_work" && (
              <div className="flex items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3">
                <label className="flex flex-1 items-center gap-2 text-sm font-bold text-amber-900">
                  שעת הגעה
                  <input
                    type="time"
                    dir="ltr"
                    value={lateTime}
                    onChange={(e) => setLateTime(e.target.value)}
                    className="ml-auto rounded-xl border border-line bg-surface px-2 py-1.5 text-base"
                  />
                </label>
                <button
                  type="button"
                  disabled={readOnly || !/^\d{2}:\d{2}$/.test(lateTime)}
                  onClick={() => updateArrival(current.student_id, lateTime)}
                  className="rounded-full bg-ink px-4 py-2 text-sm font-extrabold text-white disabled:opacity-60"
                >
                  עדכון שעה
                </button>
              </div>
            )}
            {curStatus !== "unresolved" && !readOnly && (
              <button
                type="button"
                onClick={() => clearRecord(current.student_id)}
                className="self-start rounded-full px-2 py-1 text-xs font-semibold text-muted hover:bg-bg"
              >
                נקה דיווח
              </button>
            )}
          </div>
        )}

        <div className="mt-3 flex justify-between">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(i + 1, queue.length - 1))}
            className="rounded-full px-3 py-1.5 text-sm font-bold text-muted"
          >
            דלג/י ›
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            className="rounded-full px-3 py-1.5 text-sm font-bold text-muted"
          >
            ‹ חזור/י
          </button>
        </div>
      </div>
    </div>
  );
}
