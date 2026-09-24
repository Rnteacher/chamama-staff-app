/**
 * Home student scoping — the canonical relationship tables decide, never the
 * user-role list: a staff member sees the students of home groups they
 * actually mentor (group_mentors), students assigned to them as master
 * (master_assignments) and the students of every major they head
 * (major_heads, via is_major_head_for_student). Administrative/privileged
 * roles grant NOTHING here — a broad viewer does not get a broad student
 * table on Home.
 */
export interface HomeStudentScopes<T> {
  mentorRows: T[];
  masterRows: T[];
  majorRows: T[];
}

export function scopeHomeStudents<T extends { student_id: string }>(
  rows: readonly T[],
  mentoredStudentIds: ReadonlySet<string>,
  masteredStudentIds: ReadonlySet<string>,
  majorHeadStudentIds: ReadonlySet<string> = new Set()
): HomeStudentScopes<T> {
  // one row per student (the union over several majors never duplicates)
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.student_id) && Boolean(seen.add(r.student_id)));
  return {
    mentorRows: unique.filter((r) => mentoredStudentIds.has(r.student_id)),
    masterRows: unique.filter((r) => masteredStudentIds.has(r.student_id)),
    majorRows: unique.filter((r) => majorHeadStudentIds.has(r.student_id)),
  };
}
