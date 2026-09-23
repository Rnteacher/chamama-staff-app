"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEmploymentOverrideAction } from "@/lib/actions/employment";

/**
 * Student-management action for employment managers: adds a student whom
 * employment does not currently apply to (e.g. the youngest cohort) by
 * setting the existing force-eligible override. The Employment section then
 * appears on its own. Authorization and audit live in the server action /
 * admin_set_employment_override RPC.
 */
export default function AddToEmploymentButton({ studentId }: { studentId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const fd = new FormData();
            fd.set("studentId", studentId);
            fd.set("override", "eligible");
            const res = await setEmploymentOverrideAction(null, fd);
            if (res.ok) {
              setError(null);
              router.refresh();
            } else {
              setError(res.error);
            }
          })
        }
        className="rounded-full border border-line px-3 py-1 text-xs font-bold hover:bg-brand-soft/40 disabled:opacity-60"
      >
        {pending ? "…" : "הוספה לתעסוקה"}
      </button>
      {error && (
        <span role="alert" className="text-xs font-bold text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
