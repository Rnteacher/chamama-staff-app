"use client";

import { useActionState, useMemo, useState } from "react";
import {
  addLearningGroupMemberAction,
  removeLearningGroupMemberAction,
} from "@/lib/actions/learning-groups";

export interface PickerStudent {
  id: string;
  firstName: string;
  lastName: string;
}

interface AddFormProps {
  groupId: string;
  student: PickerStudent;
  onAdded?: () => void;
}

function AddStudentForm({ groupId, student }: AddFormProps) {
  const [state, formAction, pending] = useActionState(
    addLearningGroupMemberAction,
    null
  );
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="studentId" value={student.id} />
      <span className="text-sm">
        {student.firstName} {student.lastName}
      </span>
      {state && !state.ok && (
        <span role="alert" className="text-xs font-semibold text-danger">
          {state.error}
        </span>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-ink px-3 py-1 text-xs font-bold text-white disabled:opacity-60"
      >
        {pending ? "מוסיף…" : "הוספה"}
      </button>
    </form>
  );
}

/**
 * Searchable student picker for adding members to a learning group.
 * Pure UI: authorization is enforced server-side by the RPC.
 */
export function LearningGroupMemberPicker({
  groupId,
  students,
}: {
  groupId: string;
  students: PickerStudent[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return students;
    return students.filter((s) =>
      `${s.firstName} ${s.lastName}`.includes(q)
    );
  }, [query, students]);

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <label htmlFor="lg-member-search" className="block text-sm font-bold">
        הוספת חניך/ה לקבוצה
      </label>
      <input
        id="lg-member-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="חיפוש חניך/ה…"
        className="mt-2 w-full rounded-xl border border-line px-3 py-2 text-sm"
      />
      <div className="mt-3 flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted">לא נמצאו חניכים.</p>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-xl px-2 py-1.5 hover:bg-brand-soft/30"
            >
              <AddStudentForm groupId={groupId} student={s} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function LearningGroupMemberRemoveButton({
  groupId,
  studentId,
  studentName,
}: {
  groupId: string;
  studentId: string;
  studentName: string;
}) {
  const [state, formAction, pending] = useActionState(
    removeLearningGroupMemberAction,
    null
  );
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="studentId" value={studentId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`הסרת ${studentName} מהקבוצה`}
        className="rounded-full border border-line px-3 py-1 text-xs font-bold text-danger disabled:opacity-60"
      >
        {pending ? "מסיר…" : "הסרה"}
      </button>
      {state && !state.ok && (
        <span role="alert" className="text-xs font-semibold text-danger">
          {state.error}
        </span>
      )}
    </form>
  );
}
