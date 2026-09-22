"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { computeEmploymentProgress } from "@/lib/employment";

export interface EmploymentRow {
  studentId: string;
  studentName: string;
  groupName: string | null;
  /** canonical cohort eligibility (youngest active cohort = false) */
  employmentEligible: boolean;
  /** youngest-cohort note or invalid-group-name warning */
  cohortNote: string | null;
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
 * compact mobile list. Filters: group / workplace / status / progress.
 * Eligibility is DERIVED from the home-group cohort order (canonical SQL) —
 * no per-student year is required or shown. The youngest active cohort is
 * surfaced with a note, not hidden.
 */
export default function EmploymentAdminTable({
  rows,
  groups,
  cohortWarnings,
}: {
  rows: EmploymentRow[];
  groups: { id: string; name: string }[];
  /** administrative warnings for current groups with unrecognizable names */
  cohortWarnings: string[];
}) {
  const [group, setGroup] = useState("");
  const [workplace, setWorkplace] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [bucket, setBucket] = useState<BucketFilter>("all");
  const [name, setName] = useState("");

  const filtered = useMemo(() => {
    const wp = workplace.trim().toLowerCase();
    return rows.filter((r) => {
      if (group && r.groupName !== groups.find((g) => g.id === group)?.name) return false;
      if (wp && !(r.workplaceName ?? "").toLowerCase().includes(wp)) return false;
      if (name && !r.studentName.includes(name.trim())) return false;
      const b = computeEmploymentProgress(r.totalMinutes).bucket;
      if (bucket !== "all" && b !== bucket) return false;
      if (status === "active" && !r.placementActive) return false;
      if (status === "ended" && (r.placementActive !== false || !r.placementId)) return false;
      if (status === "none" && r.placementId) return false;
      return true;
    });
  }, [rows, groups, group, workplace, status, bucket, name]);

  return (
    <div className="flex flex-col gap-3">
      {cohortWarnings.length > 0 && (
        <div role="alert" className="rounded-2xl border border-warn bg-amber-50 p-3 text-sm">
          {cohortWarnings.map((w) => (
            <p key={w} className="font-bold text-warn">⚠ {w}</p>
          ))}
          <p className="mt-1 text-xs text-muted">
            קבוצה בשם שאינו מתחיל באות השנתון (א׳–ת׳) לא נכללת בחישוב סדר השנתון.
          </p>
        </div>
      )}

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
              <th className="px-3 py-2.5 font-bold">זכאות</th>
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
                      {r.cohortNote ? (
                        <span
                          data-cohort-note="true"
                          className="inline-block rounded-full border border-line bg-bg px-2 py-0.5 text-xs font-bold text-muted"
                          title={r.cohortNote}
                        >
                          {r.employmentEligible ? "כן · לתשומת לב" : "לא · שנתון צעיר"}
                        </span>
                      ) : r.employmentEligible ? (
                        <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-900">
                          כן
                        </span>
                      ) : (
                        <span className="rounded-full border border-line bg-bg px-2 py-0.5 text-xs font-bold text-muted">
                          לא
                        </span>
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
                      <span className={r.employmentEligible ? "font-bold" : "font-bold text-warn"}>
                        {r.employmentEligible ? "זכאי/ת" : "שנתון צעיר"}
                      </span>
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
