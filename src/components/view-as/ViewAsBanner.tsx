"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { exitViewAsAction } from "@/lib/actions/view-as";

const ROLE_LABELS: Record<string, string> = {
  staff: "איש/אשת צוות",
  mentor: "מנטור/ית",
  master: "מאסטר/ית",
  major_head: "ראש/ית מגמה",
  project_coordinator: "אחראי/ת פרויקטים",
};

export default function ViewAsBanner({
  staffName,
  roleContext,
}: {
  staffName: string;
  roleContext: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const roleLabel = ROLE_LABELS[roleContext] ?? roleContext;

  return (
    <div
      role="status"
      className="sticky top-14 z-30 flex items-center justify-between gap-3 border-b-2 border-amber-400 bg-amber-50 px-4 py-2.5"
    >
      <p className="text-sm font-bold text-amber-900">
        מצב צפייה כ־<span className="font-extrabold">{staffName}</span>
        {" · "}
        <span>{roleLabel}</span>
        <span className="mr-2 text-xs font-medium text-amber-700">
          (קריאה בלבד)
        </span>
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await exitViewAsAction();
            router.refresh();
          })
        }
        className="shrink-0 rounded-full border border-amber-400 bg-white px-3 py-1 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
      >
        {pending ? "יוצא…" : "יציאה ממצב צפייה"}
      </button>
    </div>
  );
}
