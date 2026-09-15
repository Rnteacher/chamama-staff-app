"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendMessageAction } from "@/lib/actions/messages";

export default function Composer({
  studentId,
  canModerate,
}: {
  studentId: string;
  canModerate: boolean;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState("");
  const [generalVisible, setGeneralVisible] = useState(false);
  const [hiddenFromLeads, setHiddenFromLeads] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  function open() {
    setError(null);
    setSent(false);
    dialogRef.current?.showModal();
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  function close() {
    dialogRef.current?.close();
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await sendMessageAction({
        studentId,
        body,
        isGeneralVisible: generalVisible,
        isHiddenFromLeads: hiddenFromLeads,
      });
      if (res.ok) {
        setBody("");
        setGeneralVisible(false);
        setHiddenFromLeads(false);
        setSent(true);
        router.refresh();
        setTimeout(close, 650);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <>
      <div
        className="sticky bottom-[72px] z-10 -mx-4 px-4 pt-2"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <button
          type="button"
          onClick={open}
          className="mx-auto flex w-full max-w-md items-center justify-center gap-2 rounded-full bg-brand px-6 py-4 text-lg font-extrabold text-ink shadow-lg transition-transform active:scale-[0.98]"
        >
          <SendGlyph />
          שליחת עדכון
        </button>
      </div>

      <dialog
        ref={dialogRef}
        aria-label="שליחת עדכון"
        className="m-auto w-[min(92vw,30rem)] rounded-3xl border border-line bg-surface p-0 backdrop:bg-black/50"
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3 p-5"
        >
          <h2 className="text-lg font-extrabold">עדכון חדש על החניך/ה</h2>

          <label htmlFor="composer-body" className="sr-only">
            תוכן העדכון
          </label>
          <textarea
            id="composer-body"
            ref={textareaRef}
            rows={5}
            maxLength={5000}
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="כתבו עדכון קצר וברור…"
            className="w-full resize-y rounded-2xl border border-line bg-white px-4 py-3 text-[15px] leading-7"
          />

          {canModerate && (
            <fieldset className="rounded-2xl border border-line p-3">
              <legend className="px-1 text-sm font-bold">נראות (למנטורי הקבוצה)</legend>
              <label className="flex items-center gap-3 py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={generalVisible}
                  onChange={(e) => setGeneralVisible(e.target.checked)}
                  className="h-5 w-5 accent-[#46b800]"
                />
                זמין לכל הצוות
              </label>
              <label className="flex items-center gap-3 py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={hiddenFromLeads}
                  onChange={(e) => setHiddenFromLeads(e.target.checked)}
                  className="h-5 w-5 accent-[#46b800]"
                />
                מוסתר ממאסטרים וראשי מגמה
              </label>
            </fieldset>
          )}

          {sent && (
            <p role="status" className="text-sm font-bold text-brand-dark">
              העדכון נשלח בהצלחה
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm font-bold text-danger">
              {error}
            </p>
          )}

          <div className="mt-1 flex gap-2">
            <button
              type="submit"
              disabled={pending || body.trim().length === 0}
              className="flex-1 rounded-full bg-brand px-4 py-3 font-extrabold text-ink disabled:opacity-50"
            >
              {pending ? "שולחים…" : "שליחה"}
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-full border border-line px-5 py-3 font-bold"
            >
              ביטול
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function SendGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M22 2 11 13" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
