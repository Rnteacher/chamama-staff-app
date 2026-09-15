"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { markStudentAllReadAction } from "@/lib/actions/messages";

export default function MarkStudentReadButton({
  studentId,
  label,
}: {
  studentId: string;
  label: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markStudentAllReadAction(studentId);
          router.refresh();
        })
      }
      className="rounded-full bg-ink px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
    >
      {pending ? "מסמן…" : label}
    </button>
  );
}
