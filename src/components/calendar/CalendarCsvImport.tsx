"use client";

import { useActionState, useRef, useState } from "react";
import {
  previewCalendarCsvImportAction,
  confirmCalendarCsvImportAction,
  type CalendarCsvPreview,
} from "@/lib/actions/calendar";
import { CALENDAR_CSV_SAMPLE } from "@/lib/calendar-csv";

/**
 * "יבוא אירועים מ-CSV" — leadership/super_admin only (page-level guard).
 * Flow: choose file → PREVIEW with per-row validation errors → explicit
 * confirm → canonical import (same validation/RPC/audit as manual creation,
 * single transaction). Includes a downloadable Hebrew UTF-8 template.
 */
export default function CalendarCsvImport() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, previewAction, previewing] = useActionState<CalendarCsvPreview | null, FormData>(
    previewCalendarCsvImportAction,
    null
  );
  const [result, confirmAction, importing] = useActionState<CalendarCsvPreview | null, FormData>(
    confirmCalendarCsvImportAction,
    null
  );
  const formRef = useRef<HTMLFormElement>(null);

  function downloadSample() {
    // UTF-8 BOM so Excel opens Hebrew correctly
    const blob = new Blob(["\uFEFF" + CALENDAR_CSV_SAMPLE], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "calendar-events-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function chooseFile(f: File | null) {
    setFile(f);
    if (f) {
      const fd = new FormData();
      fd.set("file", f);
      previewAction(fd);
    }
  }

  const allValid = Boolean(preview?.ok && preview.invalidCount === 0 && (preview.validCount ?? 0) > 0);
  const imported = result?.ok && result.error?.startsWith("יובאו");

  return (
    <section aria-labelledby="csv-import-heading" className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="csv-import-heading" className="text-sm font-bold">
          יבוא אירועים מ-CSV
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={downloadSample}
            className="rounded-full border border-line px-3 py-1.5 text-xs font-bold text-muted hover:bg-bg"
          >
            הורדת קובץ לדוגמה
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded-full border border-line px-3 py-1.5 text-xs font-bold text-muted hover:bg-bg"
          >
            {open ? "סגירה" : "פתיחה"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          <p className="text-xs text-muted">
            עמודות: כותרת · תאריך התחלה · שעת התחלה · תאריך סיום · שעת סיום · כל היום · חזרה · חזרה עד ·
            קהל יעד (מופרד ב־;). קהל יעד בשמות אנושיים — למשל כולם, צוות, שם קבוצה, שם מגמה, שם
            קבוצת למידה או אימייל איש צוות. קידוד UTF-8.
          </p>

          <form ref={formRef} action={confirmAction} className="flex flex-col gap-3">
            <label className="text-sm font-bold">
              קובץ CSV
              <input
                type="file"
                name="file"
                accept=".csv,text/csv"
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                className="mr-2 block w-full rounded-xl border border-line px-3 py-2 text-sm"
              />
            </label>

            {previewing && <p className="text-sm text-muted">מנתח…</p>}
            {preview && !preview.ok && (
              <p role="alert" className="text-sm text-danger">{preview.error}</p>
            )}

            {preview?.ok && preview.rows && preview.rows.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[640px] text-xs" dir="rtl">
                  <thead>
                    <tr className="border-b border-line text-right text-muted">
                      <th className="px-3 py-2 font-bold">שורה</th>
                      <th className="px-3 py-2 font-bold">כותרת</th>
                      <th className="px-3 py-2 font-bold">תאריכים</th>
                      <th className="px-3 py-2 font-bold">קהל יעד</th>
                      <th className="px-3 py-2 font-bold">מצב</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.line} className="border-b border-line/50 last:border-0">
                        <td className="px-3 py-2">{r.line}</td>
                        <td className="px-3 py-2 font-bold">{r.title || "—"}</td>
                        <td className="px-3 py-2" dir="ltr">
                          {r.startDate}
                          {r.endDate && r.endDate !== r.startDate ? ` → ${r.endDate}` : ""}
                          {r.isAllDay ? " · כל היום" : ""}
                          {r.recurrence !== "none" ? ` · ${r.recurrence === "weekly" ? "שבועי" : "חודשי"}` : ""}
                        </td>
                        <td className="px-3 py-2">{r.audiencesPreview.join("; ") || "—"}</td>
                        <td className="px-3 py-2">
                          {r.valid ? (
                            <span className="font-bold text-emerald-700">תקינה</span>
                          ) : (
                            <span className="font-bold text-danger">{r.errors.join(" · ")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview?.ok && (
              <p className="text-xs font-bold">
                {preview.validCount ?? 0} שורות תקינות
                {(preview.invalidCount ?? 0) > 0 && (
                  <span className="text-danger"> · {preview.invalidCount} שורות נפסלו</span>
                )}
              </p>
            )}

            {imported ? (
              <p role="status" className="text-sm font-bold text-emerald-700">{result?.error}</p>
            ) : (
              result && !result.ok && result.error && (
                <p role="alert" className="text-sm text-danger">{result.error}</p>
              )
            )}

            <div>
              <button
                type="submit"
                disabled={!file || importing || !allValid}
                className="rounded-full bg-ink px-5 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
              >
                {importing ? "מייבא…" : "אישור ייבוא"}
              </button>
              {!allValid && file && !previewing && (
                <span className="mr-2 text-xs text-muted">
                  הייבוא נעול עד שכל השורות תקינות
                </span>
              )}
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
