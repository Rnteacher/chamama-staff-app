/**
 * Home student scoping — the canonical relationship tables decide, never the
 * user-role list: a staff member sees the students of home groups they
 * actually mentor (group_mentors) and students assigned to them as master
 * (master_assignments). Administrative/privileged roles grant NOTHING here —
 * a broad viewer does not get a broad student table on Home.
 */
export interface HomeStudentScopes<T> {
  mentorRows: T[];
  masterRows: T[];
}

export function scopeHomeStudents<T extends { student_id: string }>(
  rows: readonly T[],
  mentoredStudentIds: ReadonlySet<string>,
  masteredStudentIds: ReadonlySet<string>
): HomeStudentScopes<T> {
  return {
    mentorRows: rows.filter((r) => mentoredStudentIds.has(r.student_id)),
    masterRows: rows.filter((r) => masteredStudentIds.has(r.student_id)),
  };
}
