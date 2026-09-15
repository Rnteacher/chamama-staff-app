"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { markMessagesReadAction } from "@/lib/actions/messages";

export default function MarkAllReadButton({
  messageIds,
  label,
}: {
  messageIds: string[];
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
          await markMessagesReadAction({ messageIds });
          router.refresh();
        })
      }
      className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
    >
      {pending ? "מסמן…" : label}
    </button>
  );
}
