"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEmploymentOverrideAction } from "@/lib/actions/employment";
import {
  EMPLOYMENT_OVERRIDE_LABELS,
  type EmploymentOverrideState,
} from "@/lib/employment";

/**
 * Tri-state per-student employment-eligibility override (student page,
 * employment managers only — leadership / super_admin / employment
 * coordinator). canonical decision + audit live in the database RPC; the
 * state is automatic / force eligible / force ineligible — never a plain
 * boolean, so "no decision" stays distinguishable from an explicit one.
 */
export default function EmploymentOverrideControl({
  studentId,
  override,
}: {
  studentId: string;
  override: EmploymentOverrideState;
}) {
  const [value, setValue] = useState<EmploymentOverrideState>(override);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-bg p-3">
      <h3 className="text-xs font-extrabold text-muted">זכאות לפי ברירת המחדל</h3>
      <select
        aria-label="זכאות תעסוקה ידנית"
        value={value}
        onChange={(e) => {
          setValue(e.target.value as EmploymentOverrideState);
          setSaved(false);
          setError(null);
        }}
        className="rounded-xl border border-line bg-white px-3 py-1.5 text-sm"
      >
        {(Object.keys(EMPLOYMENT_OVERRIDE_LABELS) as EmploymentOverrideState[]).map(
          (k) => (
            <option key={k} value={k}>
              {EMPLOYMENT_OVERRIDE_LABELS[k]}
            </option>
          )
        )}
      </select>
      <button
        type="button"
        disabled={pending || value === override}
        onClick={() =>
          startTransition(async () => {
            const fd = new FormData();
            fd.set("studentId", studentId);
            fd.set("override", value);
            const res = await setEmploymentOverrideAction(null, fd);
            if (res.ok) {
              setSaved(true);
              setError(null);
              router.refresh();
            } else {
              setSaved(false);
              setError(res.error);
            }
          })
        }
        className="rounded-full bg-ink px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
      >
        {pending ? "…" : "שמירה"}
      </button>
      {saved && <span className="text-[11px] font-bold text-brand-dark">נשמר</span>}
      {error && (
        <span role="alert" className="text-[11px] font-bold text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
