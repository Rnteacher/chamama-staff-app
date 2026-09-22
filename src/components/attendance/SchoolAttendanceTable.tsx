"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  markSchoolAttendanceFastAction,
  clearSchoolAttendanceAction,
  bulkMarkPresentAction,
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
 * DESKTOP school attendance — a wide operational table (NOT the
 * conversational one-by-one flow). Row buttons update INSTANTLY (optimistic
 * local state; persistence in a background per-student queue; no route
 * refresh per mark). The bulk action is ONE batch mutation.
 */
export default function SchoolAttendanceTable({
  students,
  date,
  groupId,
  readOnly = false,
}: {
  students: SchoolAttendanceRosterRow[];
  date: string;
  groupId: string;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lateFor, setLateFor] = useState<string | null>(null);
  const [lateTime, setLateTime] = useState<string>(jerusalemNowHHMM());
  const [confirmBulk, setConfirmBulk] = useState(false);

  const api = useOptimisticAttendance(
    ({ studentId, status, arrivalTime }) =>
      markSchoolAttendanceFastAction({ studentId, date, status, arrivalTime }),
    () => startRefresh(() => router.refresh())
  );
  const { state: local, mark, retry, pendingCount, errorIds } = api;

  const rows = useMemo(() => sortRosterForReopen(students), [students]);

  const statusOf = (s: SchoolAttendanceRosterRow): EffectiveStatus => {
    const o = local[s.student_id];
    if (o) return o.status;
    return s.effective.status;
  };
  const reported = rows.filter((s) => statusOf(s) !== "unresolved").length;

  function save(studentId: string, status: "present" | "absent" | "late", arrivalTime?: string) {
    setError(null);
    setNotice(null);
    mark(studentId, status, status === "late" ? (arrivalTime ?? jerusalemNowHHMM()) : null);
  }

  function clearRecord(studentId: string) {
    setError(null);
    const fd = new FormData();
    fd.set("studentId", studentId);
    fd.set("date", date);
    startRefresh(async () => {
      const res = await clearSchoolAttendanceAction(null, fd);
      if (res.ok) {
        router.refresh();
      } else setError(res.error);
    });
  }

  function runBulk() {
    setError(null);
    const fd = new FormData();
    fd.set("groupId", groupId);
    fd.set("date", date);
    startRefresh(async () => {
      const res = await bulkMarkPresentAction(null, fd);
      setConfirmBulk(false);
      if (res.ok) {
        setNotice(`סומנו ${res.marked ?? 0} חניכים כנוכחים`);
        router.refresh();
      } else setError(res.error);
    });
  }

  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold">
          {reported} מתוך {rows.length} דווחו
          {notice && <span className="mr-2 font-medium text-emerald-700">{notice}</span>}
          {error && <span className="mr-2 font-medium text-danger">{error}</span>}
          {(pendingCount > 0 || isRefreshing) && (
            <span className="mr-2 text-xs font-medium text-muted" aria-live="polite">
              שומר…
            </span>
          )}
        </p>
        {errorIds.length > 0 && (
          <button
            type="button"
            onClick={() => errorIds.forEach((id) => retry(id))}
            className="rounded-full border border-danger px-4 py-2 text-xs font-bold text-danger"
          >
            {errorIds.length} שורות לא נשמרו — נסו שוב
          </button>
        )}
        {!readOnly &&
          (confirmBulk ? (
            <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold">
              <span>לסמן את כל מי שלא סומן כנוכח? לא יידרסו חסר/איחור/בעבודה.</span>
              <button type="button" onClick={runBulk}
                className="rounded-full bg-ink px-3 py-1 font-extrabold text-white">
                אישור
              </button>
              <button type="button" onClick={() => setConfirmBulk(false)}
                className="rounded-full border border-line px-3 py-1">ביטול</button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmBulk(true)}
              className="rounded-full border border-line px-4 py-2 text-xs font-bold text-muted hover:bg-bg">
              סמן את כל מי שלא סומן כנוכח
            </button>
          ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="px-4 py-3 font-bold">חניך/ה</th>
              <th className="px-4 py-3 font-bold">הקשר מצופה</th>
              <th className="px-4 py-3 font-bold">סטטוס</th>
              <th className="px-4 py-3 font-bold">שעת הגעה</th>
              <th className="px-4 py-3 font-bold">הגעה מתוכננת</th>
              <th className="px-4 py-3 font-bold">יציאה מתוכננת</th>
              <th className="px-4 py-3 font-bold">הסבר</th>
              <th className="px-4 py-3 font-bold">עדכון אחרון</th>
              <th className="px-4 py-3 font-bold">פעולות</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const st = statusOf(s);
              const eff = s.effective;
              const o = local[s.student_id];
              const plan = formatPlanHe(eff);
              const updatedAt = eff.updated_at
                ? new Date(eff.updated_at).toLocaleString("he-IL", {
                    day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
                    timeZone: "Asia/Jerusalem", hour12: false,
                  })
                : "—";
              const arrivalDisplay =
                st === "late"
                  ? lateFor === s.student_id
                    ? null
                    : (o?.arrival ?? normalizeDbTime(eff.arrival_time) ?? "—")
                  : null;
              return (
                <tr key={s.student_id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-3 font-bold whitespace-nowrap">
                    {s.first_name} {s.last_name}
                    {o?.save === "error" && (
                      <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-danger px-2 py-0.5 text-[11px] font-bold text-danger">
                        לא נשמר
                        <button type="button" onClick={() => retry(s.student_id)} className="underline">
                          נסו שוב
                        </button>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {st === "expected_work" && eff.workplace_name
                      ? `בעבודה · ${eff.workplace_name}`
                      : plan || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-extrabold ${
                        st === "present"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                          : st === "absent"
                            ? "border-red-300 bg-red-50 text-red-900"
                            : st === "late"
                              ? "border-amber-300 bg-amber-50 text-amber-900"
                              : st === "expected_work"
                                ? "border-line bg-bg text-muted"
                                : "border-dashed border-muted text-muted"
                      }`}
                    >
                      {EFFECTIVE_STATUS_LABELS[st]}
                    </span>
                  </td>
                  <td className="px-4 py-3" dir="ltr">
                    {lateFor === s.student_id ? (
                      <input
                        type="time"
                        dir="ltr"
                        autoFocus
                        value={lateTime}
                        onChange={(e) => setLateTime(e.target.value)}
                        className="rounded-lg border border-line px-2 py-1"
                      />
                    ) : st === "late" ? (
                      arrivalDisplay ?? "—"
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3" dir="ltr">{normalizeDbTime(eff.planned_late_arrival_time) ?? "—"}</td>
                  <td className="px-4 py-3" dir="ltr">{normalizeDbTime(eff.planned_early_departure_time) ?? "—"}</td>
                  <td className="px-4 py-3 max-w-[220px] truncate text-muted" title={eff.plan_reason ?? ""}>
                    {eff.plan_reason ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{updatedAt}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {!readOnly && (
                        <>
                          <button type="button"
                            onClick={() => save(s.student_id, "present")}
                            className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-900">
                            {ATTENDANCE_STATUS_LABELS.present}
                          </button>
                          <button type="button"
                            onClick={() => save(s.student_id, "absent")}
                            className="rounded-full border border-red-300 bg-red-50 px-3 py-1 text-xs font-bold text-red-900">
                            {ATTENDANCE_STATUS_LABELS.absent}
                          </button>
                          <button type="button"
                            onClick={() => {
                              // instant: mark late with the current Jerusalem time;
                              // the inline input then allows correcting the time
                              setLateTime(jerusalemNowHHMM());
                              setLateFor(s.student_id);
                              save(s.student_id, "late", jerusalemNowHHMM());
                            }}
                            className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-900">
                            {ATTENDANCE_STATUS_LABELS.late}
                          </button>
                          {lateFor === s.student_id && (
                            <button type="button" disabled={!/^\d{2}:\d{2}$/.test(lateTime)}
                              onClick={() => {
                                save(s.student_id, "late", lateTime);
                                setLateFor(null);
                              }}
                              className="rounded-full bg-ink px-3 py-1 text-xs font-extrabold text-white disabled:opacity-60">
                              שמירת שעה
                            </button>
                          )}
                          {st !== "unresolved" && st !== "expected_work" && (
                            <button type="button"
                              onClick={() => clearRecord(s.student_id)}
                              className="rounded-full px-2 py-1 text-xs font-semibold text-muted hover:bg-bg">
                              נקה
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
