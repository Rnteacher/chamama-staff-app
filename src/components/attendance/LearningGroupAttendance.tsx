"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveLearningGroupAttendanceAction } from "@/lib/actions/attendance";
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
 * LEARNING GROUP attendance for one actual scheduled session.
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
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, { status: AttendanceStatus; arrival: string | null }>>({});
  const [lateFor, setLateFor] = useState<string | null>(null);
  const [lateTime, setLateTime] = useState<string>(jerusalemNowHHMM());

  const statusOf = (e: LgRosterEntry): AttendanceStatus | null =>
    local[e.student_id]?.status ?? e.status;

  function save(entry: LgRosterEntry, session: LgSessionEntry,
                status: AttendanceStatus, arrivalTime?: string) {
    setError(null);
    const fd = new FormData();
    fd.set("groupId", groupId);
    fd.set("date", date);
    fd.set("startTime", session.start_time);
    fd.set("endTime", session.end_time);
    fd.set("studentId", entry.student_id);
    fd.set("status", status);
    fd.set("arrivalTime", status === "late" ? (arrivalTime ?? jerusalemNowHHMM()) : "");
    startTransition(async () => {
      const res = await saveLearningGroupAttendanceAction(null, fd);
      if (res.ok) {
        setLocal((p) => ({ ...p, [entry.student_id]: { status, arrival: arrivalTime ?? null } }));
        setLateFor(null);
        router.refresh();
      } else setError(res.error);
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
      {error && <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-danger">{error}</p>}
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
                const preResolved = Boolean(entry.school_context);
                const schoolLabel = entry.school_context
                  ? LG_SCHOOL_CONTEXT_LABELS[entry.school_context]
                  : null;
                return (
                  <li key={entry.student_id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-bold">
                        {entry.first_name} {entry.last_name}
                      </p>
                      <p className="text-xs text-muted">
                        {st
                          ? <>
                              {EFFECTIVE_STATUS_LABELS[st]}
                              {st === "late" && entry.arrival_time &&
                                <> · הגיע/ה ב־<span dir="ltr">{entry.arrival_time.slice(0, 5)}</span></>}
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
                            disabled={pending}
                            onClick={() => {
                              if (opt === "late") {
                                setLateTime(jerusalemNowHHMM());
                                setLateFor(entry.student_id);
                              } else {
                                save(entry, session, opt);
                              }
                            }}
                            className={`rounded-full border px-3 py-1 text-xs font-bold disabled:opacity-60 ${
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
                              disabled={pending || !/^\d{2}:\d{2}$/.test(lateTime)}
                              onClick={() => save(entry, session, "late", lateTime)}
                              className="rounded-full bg-ink px-3 py-1 text-xs font-extrabold text-white disabled:opacity-60"
                            >
                              שמירה
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
