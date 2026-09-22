"use client";

import { useState } from "react";
import StudentDataTable, {
  type StudentTableRow,
} from "@/components/tables/StudentDataTable";
import StudentRow, { type StudentRowData } from "@/components/StudentRow";

type StudentsView = "mentor" | "master";

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

/**
 * Home student list — strictly relationship-scoped:
 *   mentor students (canonical group_mentors) and/or master students
 *   (canonical master_assignments). BOTH relationships → a simple
 *   מנטור/מאסטר toggle; ONE relationship → no redundant toggle;
   NEITHER → the panel is not rendered at all.
 */
export default function HomeStudentsPanel({
  mentorRows,
  masterRows,
  mentorMobile,
  masterMobile,
  readOnly = false,
}: {
  mentorRows: StudentTableRow[];
  masterRows: StudentTableRow[];
  mentorMobile: StudentRowData[];
  masterMobile: StudentRowData[];
  readOnly?: boolean;
}) {
  const hasMentor = mentorRows.length > 0;
  const hasMaster = masterRows.length > 0;
  const [view, setView] = useState<StudentsView>(
    hasMentor ? "mentor" : "master"
  );
  if (!hasMentor && !hasMaster) return null;

  const active = view === "mentor" || !hasMaster ? "mentor" : "master";
  const rows = active === "mentor" ? mentorRows : masterRows;
  const mobileRows = active === "mentor" ? mentorMobile : masterMobile;
  const title = active === "mentor" ? "החניכים שלי · מנטור" : "החניכים שלי · מאסטר";

  return (
    <section aria-labelledby="my-students-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="my-students-heading" className="font-extrabold">
          החניכים שלי
        </h2>
        {hasMentor && hasMaster && (
          <div
            role="tablist"
            aria-label="סינון לפי קשר"
            className="flex gap-1 rounded-full border border-line bg-surface p-1"
          >
            {(["mentor", "master"] as const).map((v) => (
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
                {v === "mentor" ? "מנטור" : "מאסטר"}
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
          columns={active === "mentor" ? MENTOR_COLUMNS : MASTER_COLUMNS}
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
