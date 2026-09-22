"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveLearningGroupAttendanceFastAction } from "@/lib/actions/attendance";
import { useOptimisticAttendance } from "@/components/attendance/useOptimisticAttendance";
import {
  ATTENDANCE_STATUS_LABELS,
  EFFECTIVE_STATUS_LABELS,
  LG_SCHOOL_CONTEXT_LABELS,
  jerusalemNowHHMM,
  type AttendanceStatus,
} from "@/lib/attendance";

export interface LgRosterEntry {
  student_id: string;
  first_name: string;
  last_name: string;
  status: AttendanceStatus | null; // recorded LG attendance (null = unrecorded)
  arrival_time: string | null;
  school_status: string | null;
  school_context: "absent_from_school" | "expected_work" | null;
}

export interface LgSessionEntry {
  session_id: string | null;
  slot_id: string | null;
  start_time: string;
  end_time: string;
  roster: LgRosterEntry[];
}

/**
 * LEARNING GROUP attendance for one actual scheduled session — INSTANT
 * interaction (optimistic local state + background per-student queue, no
 * route refresh per mark).
 *
 * Propagation (computed server-side from the canonical resolver — never
 * copied into LG rows, so it can never go stale):
 *   * school absence → "חסר/ה מבית הספר", controls disabled (pre-resolved)
 *   * expected-at-work without a school override → "בעבודה", disabled
 * At-school absence/late produce ONE idempotent feed update + mentor push
 * (server-side); repeated saves never duplicate.
 */
export default function LearningGroupAttendance({
  groupId,
  date,
  sessions,
  readOnly = false,
}: {
  groupId: string;
  date: string;
  sessions: LgSessionEntry[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lateFor, setLateFor] = useState<string | null>(null);
  const [lateTime, setLateTime] = useState<string>(jerusalemNowHHMM());

  const api = useOptimisticAttendance<{ startTime: string; endTime: string }>(
    ({ studentId, status, arrivalTime, extra }) =>
      saveLearningGroupAttendanceFastAction({
        groupId,
        date,
        startTime: extra?.startTime ?? sessions[0]?.start_time ?? "00:00",
        endTime: extra?.endTime ?? sessions[0]?.end_time ?? "00:00",
        studentId,
        status,
        arrivalTime,
      }),
    () => startRefresh(() => router.refresh())
  );
  const { state: local, mark, retry, retryAll, pendingCount, errorIds } = api;

  const statusOf = (e: LgRosterEntry): AttendanceStatus | null =>
    local[e.student_id]?.status ?? e.status;

  function markStudent(entry: LgRosterEntry, session: LgSessionEntry,
                       status: AttendanceStatus, arrivalTime?: string) {
    setError(null);
    mark(entry.student_id, status, status === "late" ? (arrivalTime ?? jerusalemNowHHMM()) : null, {
      startTime: session.start_time,
      endTime: session.end_time,
    });
  }

  if (sessions.length === 0) {
    return (
      <p className="rounded-2xl border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
        אין מפגשי קבוצת למידה מתוכננים בתאריך זה.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {errorIds.length > 0 ? (
          <button
            type="button"
            onClick={retryAll}
            className="rounded-full border border-danger px-3 py-1.5 text-xs font-bold text-danger"
          >
            {errorIds.length} לא נשמרו — נסו שוב
          </button>
        ) : (
          <span />
        )}
        {(pendingCount > 0 || isRefreshing) && (
          <span className="text-xs text-muted" aria-live="polite">שומר…</span>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>

      {sessions.map((session) => {
        const reported = session.roster.filter((e) => statusOf(e) !== null).length;
        return (
          <section
            key={`${session.slot_id ?? session.start_time}-${session.end_time}`}
            className="rounded-2xl border border-line bg-surface"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="font-extrabold">
                מפגש <span dir="ltr">{session.start_time}–{session.end_time}</span>
              </h2>
              <span className="text-xs font-bold text-muted">
                {reported} מתוך {session.roster.length} דווחו
              </span>
            </header>

            <ul className="divide-y divide-line/60">
              {session.roster.map((entry) => {
                const st = statusOf(entry);
                const o = local[entry.student_id];
                const preResolved = Boolean(entry.school_context);
                const schoolLabel = entry.school_context
                  ? LG_SCHOOL_CONTEXT_LABELS[entry.school_context]
                  : null;
                return (
                  <li key={entry.student_id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-bold">
                        {entry.first_name} {entry.last_name}
                        {o?.save === "error" && (
                          <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-danger px-2 py-0.5 text-[11px] font-bold text-danger">
                            לא נשמר
                            <button type="button" onClick={() => retry(entry.student_id)} className="underline">
                              נסו שוב
                            </button>
                          </span>
                        )}
                        {o?.save === "saving" && (
                          <span className="mr-2 text-[11px] font-bold text-muted">שומר…</span>
                        )}
                      </p>
                      <p className="text-xs text-muted">
                        {st
                          ? <>
                              {EFFECTIVE_STATUS_LABELS[st]}
                              {st === "late" && (o?.arrival ?? entry.arrival_time) &&
                                <> · הגיע/ה ב־<span dir="ltr">{o?.arrival ?? entry.arrival_time}</span></>}
                            </>
                          : "טרם דווח"}
                        {schoolLabel && (
                          <span className={`mr-2 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
                            entry.school_context === "absent_from_school"
                              ? "border-red-300 bg-red-50 text-red-900"
                              : "border-line bg-bg text-muted"
                          }`}>
                            {schoolLabel}
                          </span>
                        )}
                      </p>
                    </div>

                    {preResolved ? (
                      <span className="shrink-0 text-xs text-muted">
                        {entry.school_context === "absent_from_school"
                          ? "מוכן/מוכנה מראש — אין צורך לסמן"
                          : "אין צורך לסמן"}
                      </span>
                    ) : readOnly ? null : (
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {(["present", "absent", "late"] as const).map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              if (opt === "late") {
                                // instant: mark late with the current Jerusalem time;
                                // the inline input then allows correcting the time
                                setLateTime(jerusalemNowHHMM());
                                setLateFor(entry.student_id);
                                markStudent(entry, session, "late", jerusalemNowHHMM());
                              } else {
                                markStudent(entry, session, opt);
                              }
                            }}
                            className={`rounded-full border px-3 py-1 text-xs font-bold ${
                              opt === "present"
                                ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                                : opt === "absent"
                                  ? "border-red-300 bg-red-50 text-red-900"
                                  : "border-amber-300 bg-amber-50 text-amber-900"
                            }`}
                          >
                            {ATTENDANCE_STATUS_LABELS[opt]}
                          </button>
                        ))}
                        {lateFor === entry.student_id && (
                          <>
                            <input
                              type="time"
                              dir="ltr"
                              value={lateTime}
                              onChange={(e) => setLateTime(e.target.value)}
                              className="rounded-lg border border-line px-2 py-1 text-xs"
                            />
                            <button
                              type="button"
                              disabled={!/^\d{2}:\d{2}$/.test(lateTime)}
                              onClick={() => markStudent(entry, session, "late", lateTime)}
                              className="rounded-full bg-ink px-3 py-1 text-xs font-extrabold text-white disabled:opacity-60"
                            >
                              עדכון שעה
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
