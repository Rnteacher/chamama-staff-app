"use client";

import { useMemo, useState } from "react";
import StudentRow, { type StudentRowData } from "@/components/StudentRow";
import EmptyState from "@/components/EmptyState";

/** Instant client-side search: tolerant of partial names, either order. */
export default function SearchClient({
  students,
}: {
  students: StudentRowData[];
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().replace(/\s+/g, " ");
    if (!q) return students;
    const lower = q.toLowerCase();
    return students.filter((s) => {
      const full = `${s.firstName} ${s.lastName}`.toLowerCase();
      const reversed = `${s.lastName} ${s.firstName}`.toLowerCase();
      return (
        full.includes(lower) ||
        reversed.includes(lower) ||
        s.firstName.toLowerCase().includes(lower) ||
        s.lastName.toLowerCase().includes(lower)
      );
    });
  }, [students, query]);

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="student-search" className="sr-only">
        חיפוש חניך לפי שם
      </label>
      <input
        id="student-search"
        type="search"
        inputMode="search"
        autoComplete="off"
        autoFocus
        placeholder="הקלידו שם חניך…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-base shadow-sm"
      />
      {results.length === 0 ? (
        <EmptyState
          title="לא נמצאו חניכים"
          description={
            query
              ? `לא נמצאה התאמה ל"‎${query}‎". נסו חלק מהשם בלבד.`
              : "אין חניכים פעילים במערכת."
          }
        />
      ) : (
        <>
          <p aria-live="polite" className="text-sm text-muted">
            {results.length} חניכים
          </p>
          <ul className="flex flex-col gap-2">
            {results.map((s) => (
              <StudentRow key={s.id} student={s} showGroup />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
