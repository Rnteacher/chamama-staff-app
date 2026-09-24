"use client";

import { useState } from "react";
import StudentDataTable, {
  type StudentTableRow,
} from "@/components/tables/StudentDataTable";
import StudentRow, { type StudentRowData } from "@/components/StudentRow";

type StudentsView = "mentor" | "master" | "major";

const MENTOR_COLUMNS = [
  "student_name",
  "group_name",
  "status",
  "last_report_at",
  "intervention",
  "mentor_next_meeting_at",
];

const MASTER_COLUMNS = [
  "student_name",
  "group_name",
  "project_major_name",
  "primary_master_name",
  "status",
  "last_report_at",
  "intervention",
  "master_next_meeting_at",
];

const MAJOR_COLUMNS = [
  "student_name",
  "group_name",
  "project_major_name",
  "primary_master_name",
  "status",
  "last_report_at",
  "intervention",
];

const VIEW_LABELS: Record<StudentsView, string> = {
  mentor: "מנטור",
  master: "מאסטר",
  major: "מגמה",
};

const VIEW_COLUMNS: Record<StudentsView, string[]> = {
  mentor: MENTOR_COLUMNS,
  master: MASTER_COLUMNS,
  major: MAJOR_COLUMNS,
};

/**
 * Home student list — strictly relationship-scoped:
 *   mentor students (canonical group_mentors), master students (canonical
 *   master_assignments) and/or major students (canonical major_heads — the
 *   union over every major the person heads). TWO OR MORE relationships →
 *   a simple מנטור/מאסטר/מגמה toggle; ONE relationship → no redundant
 *   toggle; NONE → the panel is not rendered at all.
 */
export default function HomeStudentsPanel({
  mentorRows,
  masterRows,
  majorRows = [],
  mentorMobile,
  masterMobile,
  majorMobile = [],
  readOnly = false,
}: {
  mentorRows: StudentTableRow[];
  masterRows: StudentTableRow[];
  majorRows?: StudentTableRow[];
  mentorMobile: StudentRowData[];
  masterMobile: StudentRowData[];
  majorMobile?: StudentRowData[];
  readOnly?: boolean;
}) {
  const rowsByView: Record<StudentsView, StudentTableRow[]> = {
    mentor: mentorRows,
    master: masterRows,
    major: majorRows,
  };
  const mobileByView: Record<StudentsView, StudentRowData[]> = {
    mentor: mentorMobile,
    master: masterMobile,
    major: majorMobile,
  };
  const views = (["mentor", "master", "major"] as const).filter(
    (v) => rowsByView[v].length > 0
  );
  const [view, setView] = useState<StudentsView>(views[0] ?? "mentor");
  if (views.length === 0) return null;

  const active = views.includes(view) ? view : views[0];
  const rows = rowsByView[active];
  const mobileRows = mobileByView[active];
  const title = `החניכים שלי · ${VIEW_LABELS[active]}`;

  return (
    <section aria-labelledby="my-students-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="my-students-heading" className="font-extrabold">
          החניכים שלי
        </h2>
        {views.length > 1 && (
          <div
            role="tablist"
            aria-label="סינון לפי קשר"
            className="flex gap-1 rounded-full border border-line bg-surface p-1"
          >
            {views.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={active === v}
                onClick={() => setView(v)}
                className={`rounded-full px-4 py-1.5 text-sm font-bold ${
                  active === v ? "bg-brand-soft text-ink" : "text-muted hover:bg-bg"
                }`}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* desktop: full operational table for the active relationship */}
      <div className="hidden lg:block">
        <StudentDataTable
          title={title}
          rows={rows}
          columns={VIEW_COLUMNS[active]}
          readOnly={readOnly}
        />
      </div>

      {/* mobile: compact rows */}
      <ul className="flex flex-col gap-2 lg:hidden">
        {mobileRows.slice(0, 8).map((s) => (
          <StudentRow key={s.id} student={s} showGroup />
        ))}
      </ul>
      {mobileRows.length > 8 && (
        <p className="text-sm text-muted lg:hidden">
          ועוד {mobileRows.length - 8} חניכים — השתמשו בחיפוש או בקבוצות.
        </p>
      )}
    </section>
  );
}
