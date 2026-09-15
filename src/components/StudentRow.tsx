import Link from "next/link";
import { fullName } from "@/lib/format";

export interface StudentRowData {
  id: string;
  firstName: string;
  lastName: string;
  groupName?: string | null;
  majorName?: string | null;
  unread: number;
}

export default function StudentRow({
  student,
  showGroup = false,
}: {
  student: StudentRowData;
  showGroup?: boolean;
}) {
  const name = fullName(student.firstName, student.lastName);
  const hasUnread = student.unread > 0;
  return (
    <li>
      <Link
        href={`/students/${student.id}`}
        className="flex min-h-[64px] items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 transition-colors hover:bg-brand-soft/40"
      >
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink text-sm font-extrabold text-brand"
        >
          {student.firstName.slice(0, 1)}
          {student.lastName.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold">{name}</span>
          {(showGroup && (student.groupName || student.majorName)) && (
            <span className="block truncate text-xs text-muted">
              {[
                student.groupName,
                student.majorName,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
        {hasUnread && (
          <span
            aria-label={`${student.unread} עדכונים שלא נקראו`}
            title={`${student.unread} עדכונים שלא נקראו`}
            className="flex items-center gap-1.5 rounded-full bg-brand px-2.5 py-1 text-xs font-extrabold text-ink"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ink" />
            {student.unread}
          </span>
        )}
        {!hasUnread && (
          <span aria-hidden="true" className="text-muted">‹</span>
        )}
      </Link>
    </li>
  );
}
