"use client";

import { useTransition } from "react";
import { signOutAction } from "@/components/SignOutAction";

export default function SignOutButton({
  className = "rounded-full bg-ink text-white font-bold px-6 py-3 disabled:opacity-60",
  label = "התנתקות",
}: {
  className?: string;
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => signOutAction())}
      className={className}
    >
      {pending ? "מתנתקים…" : label}
    </button>
  );
}
