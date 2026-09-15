"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/actions/messages";

export type AdminAction = (
  prev: ActionState | null,
  fd: FormData
) => Promise<ActionState>;

export default function AdminActionForm({
  action,
  children,
  submitLabel,
  className = "",
  danger = false,
  hideFeedback = false,
}: {
  action: AdminAction;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
  danger?: boolean;
  hideFeedback?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      {!hideFeedback && state && !state.ok && (
        <p role="alert" className="mt-2 text-sm font-semibold text-danger">
          {state.error}
        </p>
      )}
      {!hideFeedback && state && state.ok && (
        <p role="status" className="mt-2 text-sm font-semibold text-brand-dark">
          הפעולה בוצעה
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className={`mt-2 rounded-full px-4 py-2 text-sm font-bold disabled:opacity-60 ${
          danger
            ? "border border-line bg-surface text-danger"
            : "bg-ink text-white"
        }`}
      >
        {pending ? "מעבד…" : submitLabel}
      </button>
    </form>
  );
}
