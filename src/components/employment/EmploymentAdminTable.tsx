"use client";

import { Fragment, useActionState, useMemo, useState } from "react";
import Link from "next/link";
import {
  computeEmploymentProgress,
  schoolYearLabel,
} from "@/lib/employment";
import { setStudentSchoolYearAction } from "@/lib/actions/employment";

export interface EmploymentRow {
  studentId: string;
  studentName: string;
  groupName: string | null;
  schoolYear: number | null;
  placementId: string | null;
  workplaceName: string | null;
  placementActive: boolean | null;
  slotsSummary: string;
  totalMinutes: number;
  targetMinutes: number;
}

type BucketFilter = "all" | "below" | "at" | "above";
type StatusFilter = "all" | "active" | "ended" | "none";

/**
 * Employment management table — desktop-wide (not a narrow card), with a
 * compact mobile list. Filters: group / year / workplace / status / progress.
 * Students whose year was never set (school_year NULL — the state of every
 * pre-existing student) are SURFACED with "שנה לא הוגדרה", never hidden;
 * leadership/super_admin can set the year inline.
 */
export default function EmploymentAdminTable({
  rows,
  groups,
  canSetYear = false,
}: {
  rows: EmploymentRow[];
  groups: { id: string; name: string }[];
  canSetYear?: boolean;
}) {
  const [group, setGroup] = useState("");
  const [year, setYear] = useState("");
  const [workplace, setWorkplace] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [bucket, setBucket] = useState<BucketFilter>("all");
  const [name, setName] = useState("");

  const filtered = useMemo(() => {
    const wp = workplace.trim().toLowerCase();
    return rows.filter((r) => {
      if (group && r.groupName !== groups.find((g) => g.id === group)?.name) return false;
      if (year === "0" && r.schoolYear !== null) return false;
      if (year && year !== "0" && String(r.schoolYear ?? "") !== year) return false;
      if (wp && !(r.workplaceName ?? "").toLowerCase().includes(wp)) return false;
      if (name && !r.studentName.includes(name.trim())) return false;
      const b = computeEmploymentProgress(r.totalMinutes).bucket;
      if (bucket !== "all" && b !== bucket) return false;
      if (status === "active" && !r.placementActive) return false;
      if (status === "ended" && (r.placementActive !== false || !r.placementId)) return false;
      if (status === "none" && r.placementId) return false;
      return true;
    });
  }, [rows, groups, group, year, workplace, status, bucket, name]);

  const missingYearCount = rows.filter((r) => r.schoolYear === null).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-surface p-3">
        <label className="text-xs font-semibold">
          חניך/ה
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="שם…"
            className="mr-1 w-28 rounded-lg border border-line px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs font-semibold">
          קבוצת אם
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            className="mr-1 rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          >
            <option value="">הכל</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold">
          שכבה
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="mr-1 rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          >
            <option value="">הכל</option>
            <option value="0">לא הוגדרה{missingYearCount > 0 ? ` (${missingYearCount})` : ""}</option>
            <option value="2">ב</option>
            <option value="3">ג</option>
            <option value="4">ד</option>
          </select>
        </label>
        <label className="text-xs font-semibold">
          מקום עבודה
          <input
            value={workplace}
            onChange={(e) => setWorkplace(e.target.value)}
            placeholder="חיפוש…"
            className="mr-1 w-32 rounded-lg border border-line px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs font-semibold">
          שיבוץ
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="mr-1 rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          >
            <option value="all">הכל</option>
            <option value="active">פעיל</option>
            <option value="ended">הסתיים</option>
            <option value="none">ללא שיבוץ</option>
          </select>
        </label>
        <label className="text-xs font-semibold">
          התקדמות
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value as BucketFilter)}
            className="mr-1 rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
          >
            <option value="all">הכל</option>
            <option value="below">מתחת ל־200</option>
            <option value="at">בדיוק 200</option>
            <option value="above">מעל 200</option>
          </select>
        </label>
        <span className="mr-auto text-xs text-muted">{filtered.length} חניכים</span>
      </div>

      {/* desktop table */}
      <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface lg:block">
        <table className="w-full text-sm" dir="rtl">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="px-3 py-2.5 font-bold">חניך/ה</th>
              <th className="px-3 py-2.5 font-bold">קבוצת אם</th>
              <th className="px-3 py-2.5 font-bold">שכבה</th>
              <th className="px-3 py-2.5 font-bold">מקום עבודה</th>
              <th className="px-3 py-2.5 font-bold">ימי עבודה</th>
              <th className="px-3 py-2.5 font-bold">שעות שנצברו</th>
              <th className="px-3 py-2.5 font-bold">נותרו</th>
              <th className="px-3 py-2.5 font-bold">סטטוס</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted">
                  לא נמצאו חניכים מתאימים.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const p = computeEmploymentProgress(r.totalMinutes);
                return (
                  <Fragment key={r.studentId}>
                  <tr className="border-b border-line/50 last:border-0">
                    <td className="px-3 py-2.5 font-bold">
                      <Link href={`/admin/employment/${r.studentId}`} className="hover:underline">
                        {r.studentName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{r.groupName ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {r.schoolYear === null ? (
                        <span
                          data-year-missing="true"
                          className="inline-block rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-xs font-bold text-warn"
                        >
                          שנה לא הוגדרה
                        </span>
                      ) : (
                        schoolYearLabel(r.schoolYear)
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {r.workplaceName ?? <span className="text-muted">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted" dir="rtl">
                      {r.slotsSummary || "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="block font-bold" dir="ltr">
                        {p.label}
                      </span>
                      <span className="mt-1 block h-1.5 w-36 overflow-hidden rounded-full bg-line">
                        <span
                          className={`block h-full rounded-full ${
                            p.bucket === "above" ? "bg-ink" : "bg-brand"
                          }`}
                          style={{ width: `${Math.min(100, p.percent)}%` }}
                        />
                      </span>
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {p.remainingMinutes === 0 ? "הושלם" : `${Math.round(p.remainingMinutes / 60)} שעות`}
                    </td>
                    <td className="px-3 py-2.5">
                      {!r.placementId ? (
                        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">ללא שיבוץ</span>
                      ) : r.placementActive ? (
                        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-bold">פעיל</span>
                      ) : (
                        <span className="rounded-full border border-warn px-2 py-0.5 text-xs font-bold text-warn">הסתיים</span>
                      )}
                    </td>
                  </tr>
                  {r.schoolYear === null && canSetYear && (
                    <tr className="border-b border-line/50 bg-amber-50/60 last:border-0">
                      <td colSpan={8} className="px-3 py-2">
                        <YearSetterForm studentId={r.studentId} studentName={r.studentName} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* mobile compact list */}
      <ul className="flex flex-col gap-2 lg:hidden">
        {filtered.length === 0 ? (
          <li className="rounded-2xl border border-line bg-surface p-4 text-center text-sm text-muted">
            לא נמצאו חניכים מתאימים.
          </li>
        ) : (
          filtered.map((r) => {
            const p = computeEmploymentProgress(r.totalMinutes);
            return (
              <li key={r.studentId}>
                <Link
                  href={`/admin/employment/${r.studentId}`}
                  className="flex min-h-[64px] flex-col gap-1 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-bold">{r.studentName}</span>
                    <span className="text-xs text-muted">
                      {r.schoolYear === null ? (
                        <span className="font-bold text-warn">שנה לא הוגדרה</span>
                      ) : (
                        schoolYearLabel(r.schoolYear)
                      )}
                      {" · "}
                      {r.groupName ?? "—"}
                    </span>
                  </span>
                  <span className="text-sm">{r.workplaceName ?? "ללא שיבוץ"}</span>
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                      <span
                        className={`block h-full rounded-full ${p.bucket === "above" ? "bg-ink" : "bg-brand"}`}
                        style={{ width: `${Math.min(100, p.percent)}%` }}
                      />
                    </span>
                    <span className="shrink-0 text-xs font-bold" dir="ltr">{p.label}</span>
                  </span>
                </Link>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

/**
 * Inline year setter — leadership/super_admin only (the server action and the
 * RPC both enforce this). Setting the year makes the student employment-
 * eligible (ב/ג/ד); "—" clears the year again.
 */
function YearSetterForm({ studentId, studentName }: { studentId: string; studentName: string }) {
  const [state, formAction, pending] = useActionState(setStudentSchoolYearAction, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2 text-xs">
      <input type="hidden" name="studentId" value={studentId} />
      <span className="font-bold text-warn">שנה לא הוגדרה — {studentName}:</span>
      <label className="sr-only" htmlFor={`year-${studentId}`}>שנת לימודים</label>
      <select
        id={`year-${studentId}`}
        name="schoolYear"
        defaultValue=""
        className="rounded-lg border border-line bg-white px-2 py-1 text-xs"
      >
        <option value="">בחרו שנה…</option>
        <option value="1">א</option>
        <option value="2">ב</option>
        <option value="3">ג</option>
        <option value="4">ד</option>
        <option value="clear">— ניקוי —</option>
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-ink px-3 py-1 text-xs font-bold text-white disabled:opacity-60"
      >
        {pending ? "שומרים…" : "שמירת שנה"}
      </button>
      {state && !state.ok && (
        <span role="alert" className="font-semibold text-danger">{state.error}</span>
      )}
      {state?.ok && (
        <span role="status" className="font-semibold text-brand-dark">השנה נשמרה</span>
      )}
    </form>
  );
}