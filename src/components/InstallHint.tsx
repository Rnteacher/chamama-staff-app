"use client";

import { useEffect, useState } from "react";

/** Honest installability hint (iOS requires manual "Add to Home Screen"). */
export default function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const check = setTimeout(() => {
      const isIOS =
        /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      setShow(isIOS && !standalone);
    }, 0);
    return () => clearTimeout(check);
  }, []);

  if (!show) return null;

  return (
    <section className="rounded-2xl border border-line bg-surface p-4 text-sm leading-6">
      <h2 className="font-extrabold">התקנה למסך הבית</h2>
      <p className="mt-1 text-muted">
        ב-iPhone: הקישו על כפתור השיתוף ובחרו ״הוסף למסך הבית״ כדי להתקין
        את האפליקציה. התראות דחיפה נתמכות ב-iOS 16.4 ומעלה לאחר ההתקנה.
      </p>
    </section>
  );
}
