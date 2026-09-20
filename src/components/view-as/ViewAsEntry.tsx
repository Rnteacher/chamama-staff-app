"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { enterViewAsAction } from "@/lib/actions/view-as";

export interface ViewAsStaffOption {
  id: string;
  name: string;
  is_mentor: boolean;
  is_master: boolean;
  is_major_head: boolean;
  is_project_coordinator: boolean;
}

const CONTEXT_LABELS: Record<string, string> = {
  staff: "איש/אשת צוות",
  mentor: "מנטור/ית",
  master: "מאסטר/ית",
  major_head: "ראש/ית מגמה",
  project_coordinator: "אחראי/ת פרויקטים",
};

export default function ViewAsEntry({
  staff,
}: {
  staff: ViewAsStaffOption[];
}) {
  const [selectedId, setSelectedId] = useState("");
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const selected = staff.find((s) => s.id === selectedId) ?? null;

  const validContexts = useMemo(() => {
    if (!selected) return [];
    const ctx: string[] = ["staff"];
    if (selected.is_mentor) ctx.push("mentor");
    if (selected.is_master) ctx.push("master");
    if (selected.is_major_head) ctx.push("major_head");
    if (selected.is_project_coordinator) ctx.push("project_coordinator");
    return ctx;
  }, [selected]);

  function enter() {
    if (!selectedId || !context) {
      setError("בחרו איש צוות ותפקיד");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await enterViewAsAction(selectedId, context);
      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        setError(res.error ?? "שגיאה");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
      <label className="text-xs font-semibold text-amber-900">
        צפה כ־
        <select
          value={selectedId}
          onChange={(e) => {
            setSelectedId(e.target.value);
            setContext("");
            setError(null);
          }}
          className="mr-1 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs"
        >
          <option value="">בחרו איש צוות…</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      {selected && (
        <label className="text-xs font-semibold text-amber-900">
          בתפקיד
          <select
            value={context}
            onChange={(e) => { setContext(e.target.value); setError(null); }}
            className="mr-1 rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs"
          >
            <option value="">בחרו תפקיד…</option>
            {validContexts.map((c) => (
              <option key={c} value={c}>{CONTEXT_LABELS[c]}</option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={enter}
        disabled={pending || !selectedId || !context}
        className="rounded-full bg-amber-500 px-4 py-1.5 text-xs font-extrabold text-white disabled:opacity-50"
      >
        {pending ? "…" : "הפעלה"}
      </button>
      {error && <p role="alert" className="text-xs font-bold text-danger">{error}</p>}
    </div>
  );
}
