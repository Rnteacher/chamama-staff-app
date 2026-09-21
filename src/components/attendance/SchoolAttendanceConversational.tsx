"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  markSchoolAttendanceAction,
  clearSchoolAttendanceAction,
} from "@/lib/actions/attendance";
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
 * MOBILE conversational school attendance — student by student.
 *
 * Product rules encoded here:
 *   * reopen ordering: absent FIRST, then late, unrecorded, present,
 *     expected-at-work (sorted via the shared pure helper — never re-derived).
 *   * expected-at-work students are SKIPPED by default with a compact
 *     "בעבודה" card + a secondary explicit override ("הגיע/ה לבית הספר").
 *   * planned arrival/departure are shown PROMINENTLY but are not part of
 *     the choice list (they are plans, not attendance statuses).
 *   * single-choice answers auto-advance; איחור collects an editable arrival
 *     time prefilled with the current Asia/Jerusalem time.
 *   * re-opening/change updates the SAME record (server upsert).
 */
export default function SchoolAttendanceConversational({
  students,
  date,
  readOnly = false,
}: {
  students: SchoolAttendanceRosterRow[];
  date: string;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // local optimistic status per student (immediate feedback, server is truth)
  const [local, setLocal] = useState<Record<string, { status: EffectiveStatus; arrival?: string | null }>>({});
  const [index, setIndex] = useState(0);
  // late-arrival time for the CURRENT student (prefilled at selection time)
  const [lateTime, setLateTime] = useState<string>(jerusalemNowHHMM());
  // students expected at work stay collapsed until explicitly overridden
  const [workRevealed, setWorkRevealed] = useState<Record<string, boolean>>({});

  const queue = useMemo(() => sortRosterForReopen(students), [students]);
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

  function apply(studentId: string, status: EffectiveStatus, arrival?: string | null) {
    setLocal((p) => ({ ...p, [studentId]: { status, arrival: arrival ?? null } }));
  }

  function advance() {
    setLateTime(jerusalemNowHHMM());
    // jump to the next student that still needs attention (absent → unresolved → …)
    const nextIdx = queue.findIndex((s, i) => {
      if (i <= index) return false;
      const st = resolved.get(s.student_id);
      return st === "absent" || st === "late" || st === "unresolved";
    });
    setIndex(nextIdx === -1 ? Math.min(index + 1, queue.length - 1) : nextIdx);
  }

  function save(studentId: string, status: "present" | "absent" | "late", arrivalTime?: string) {
    if (readOnly) return;
    setError(null);
    const fd = new FormData();
    fd.set("studentId", studentId);
    fd.set("date", date);
    fd.set("status", status);
    fd.set("arrivalTime", status === "late" ? (arrivalTime ?? jerusalemNowHHMM()) : "");
    startTransition(async () => {
      const res = await markSchoolAttendanceAction(null, fd);
      if (res.ok) {
        apply(studentId, status, status === "late" ? (arrivalTime ?? jerusalemNowHHMM()) : null);
        advance();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function clearRecord(studentId: string) {
    if (readOnly) return;
    const fd = new FormData();
    fd.set("studentId", studentId);
    fd.set("date", date);
    startTransition(async () => {
      const res = await clearSchoolAttendanceAction(null, fd);
      if (res.ok) {
        setLocal((p) => {
          const next = { ...p };
          delete next[studentId];
          return next;
        });
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (queue.length === 0) return null;

  const eff = current.effective;
  const curStatus = resolved.get(current.student_id) ?? eff.status;
  const revealed = Boolean(workRevealed[current.student_id]);
  const planLine = formatPlanHe(eff);

  return (
    <div className="flex flex-col gap-3" aria-label="נוכחות היום">
      <div className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm">
        <span className="font-bold">
          {reported} מתוך {queue.length} דווחו
        </span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>

      {/* progress dots */}
      <div className="flex flex-wrap gap-1" aria-hidden="true">
        {queue.map((s) => {
          const st = resolved.get(s.student_id);
          const cls =
            st === "present" ? "bg-emerald-500"
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
                {curStatus === "late" && eff.arrival_time && (
                  <> · הגיע/ה ב־<span dir="ltr">{normalizeDbTime(eff.arrival_time)}</span></>
                )}
              </p>
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
                  disabled={pending || readOnly}
                  onClick={() => {
                    if (st === "late") {
                      setLateTime(jerusalemNowHHMM());
                    } else {
                      save(current.student_id, st);
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
            {/* איחור: editable arrival time prefilled with current Jerusalem time */}
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
                  disabled={pending || readOnly || !/^\d{2}:\d{2}$/.test(lateTime)}
                  onClick={() => save(current.student_id, "late", lateTime)}
                  className="rounded-full bg-ink px-4 py-2 text-sm font-extrabold text-white disabled:opacity-60"
                >
                  שמירה
                </button>
              </div>
            )}
            {curStatus !== "unresolved" && !readOnly && (
              <button
                type="button"
                disabled={pending}
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
