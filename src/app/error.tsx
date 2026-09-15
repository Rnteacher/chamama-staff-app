"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Message contents are never logged — only the digest.
    console.error("app error digest:", error.digest);
  }, [error]);

  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-2xl font-extrabold">משהו השתבש</h1>
      <p className="mt-2 text-muted">אירעה שגיאה. נסו שוב בעוד רגע.</p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-full bg-brand text-ink font-bold px-8 py-3"
      >
        נסיון חוזר
      </button>
    </main>
  );
}
