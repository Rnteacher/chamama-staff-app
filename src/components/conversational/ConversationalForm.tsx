"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Reusable conversational multi-step form engine (Hebrew RTL).
 *
 * One question per screen, animated directional transitions (pure CSS —
 * no animation dependency), progress indicator, conditional questions,
 * per-question validation, Back/Next, keyboard-accessible options, focus
 * management, reduced-motion support, built-in review + submit states.
 */

export type QuestionOption = { value: string; label: string; hint?: string };

export interface Question {
  id: string;
  title: string;
  subtitle?: string;
  type: "single-select" | "multi-select" | "text" | "textarea" | "datetime";
  options?: QuestionOption[];
  placeholder?: string;
  maxLength?: number;
  /** question is shown only when this returns true for current answers */
  visibleWhen?: (answers: Record<string, unknown>) => boolean;
  /** return an error string to block advancing; null/undefined = valid */
  validate?: (answers: Record<string, unknown>) => string | null;
  optional?: boolean;
}

export type Answers = Record<string, unknown>;

interface ConversationalFormProps {
  questions: Question[];
  answers: Answers;
  onAnswersChange: (answers: Answers) => void;
  /** called with the final answers when the user confirms on the review step */
  onSubmit: () => Promise<void>;
  submitLabel?: string;
  /** brief success state text after resolve */
  successText?: string;
  /** external error to display on the review step */
  submitError?: string | null;
  disabled?: boolean;
  /** invoked when the user goes back from the first question (e.g. close) */
  onBack?: () => void;
}

export default function ConversationalForm({
  questions,
  answers,
  onAnswersChange,
  onSubmit,
  submitLabel = "שליחה",
  successText = "נשלח בהצלחה",
  submitError = null,
  disabled = false,
  onBack,
}: ConversationalFormProps) {
  const visible = useMemo(
    () => questions.filter((q) => !q.visibleWhen || q.visibleWhen(answers)),
    [questions, answers]
  );
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"questions" | "review" | "submitting" | "done">(
    "questions"
  );
  const headingRef = useRef<HTMLHeadingElement>(null);

  const safeIndex = Math.min(index, Math.max(0, visible.length - 1));
  const q = visible[safeIndex];

  const goTo = useCallback((next: number, dir: 1 | -1) => {
    setDirection(dir);
    setIndex(next);
    setQuestionError(null);
  }, []);

  // focus the question heading on every step change (a11y)
  useEffect(() => {
    if (phase === "questions") {
      headingRef.current?.focus();
    }
  }, [safeIndex, phase]);

  function validateCurrent(): string | null {
    if (!q) return null;
    if (q.validate) return q.validate(answers);
    const value = answers[q.id];
    if (q.optional) return null;
    if (q.type === "multi-select") {
      const arr = Array.isArray(value) ? value : [];
      return arr.length === 0 ? "בחרו לפחות אפשרות אחת" : null;
    }
    if (q.type === "text" || q.type === "textarea" || q.type === "datetime") {
      return typeof value === "string" && value.trim() !== ""
        ? null
        : "שדה זה נדרש";
    }
    return value == null || value === "" ? "בחרו תשובה" : null;
  }

  function next() {
    const err = validateCurrent();
    if (err) {
      setQuestionError(err);
      return;
    }
    if (safeIndex + 1 < visible.length) {
      goTo(safeIndex + 1, 1);
    } else {
      setPhase("review");
    }
  }

  function back() {
    if (phase === "review") {
      setPhase("questions");
      setDirection(-1);
      return;
    }
    if (safeIndex > 0) {
      goTo(safeIndex - 1, -1);
    } else {
      onBack?.();
    }
  }

  function setValue(id: string, value: unknown) {
    setQuestionError(null);
    onAnswersChange({ ...answers, [id]: value });
    // auto-advance single-select (not multi-select, not text, not textarea, not datetime)
    if (q && q.type === "single-select") {
      const err = q.validate ? q.validate({ ...answers, [id]: value }) : null;
      if (!err) {
        if (safeIndex + 1 < visible.length) {
          goTo(safeIndex + 1, 1);
        } else {
          setPhase("review");
        }
      }
    }
  }

  function toggleMulti(id: string, value: string) {
    const arr = Array.isArray(answers[id]) ? [...(answers[id] as string[])] : [];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(value);
    setValue(id, arr);
  }

  async function submit() {
    setPhase("submitting");
    try {
      await onSubmit();
      setPhase("done");
    } catch {
      setPhase("review");
    }
  }

  if (phase === "done") {
    return (
      <div className="rounded-3xl border border-line bg-surface p-8 text-center" role="status">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand text-ink">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="mt-4 text-lg font-extrabold">{successText}</p>
      </div>
    );
  }

  const isReview = phase === "review" || phase === "submitting";
  const progress = isReview ? 1 : visible.length ? safeIndex / visible.length : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* progress */}
      <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-brand-dark transition-all duration-500 motion-reduce:transition-none"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <p className="text-xs font-medium text-muted" aria-live="polite">
        {isReview ? "סיכום ואישור" : `שאלה ${safeIndex + 1} מתוך ${visible.length}`}
      </p>

      {isReview ? (
        <section
          aria-label="סיכום התשובות"
          className={`rounded-3xl border border-line bg-surface p-5 ${
            phase === "submitting" ? "opacity-70" : ""
          }`}
        >
          <h2 className="text-lg font-extrabold" tabIndex={-1}>בדיקה אחרונה</h2>
          <dl className="mt-3 flex flex-col gap-2 text-sm">
            {visible.map((vq) => {
              const value = answers[vq.id];
              let display = "";
              if (vq.type === "multi-select" && Array.isArray(value)) {
                display = value
                  .map((v) => vq.options?.find((o) => o.value === v)?.label ?? v)
                  .join(" · ");
              } else if (vq.type === "single-select") {
                display = vq.options?.find((o) => o.value === value)?.label ?? String(value ?? "");
              } else if (vq.type === "datetime") {
                display = String(value ?? "").replace("T", " ");
              } else {
                display = String(value ?? "");
              }
              if (typeof value === "boolean") display = value ? "כן" : "לא";
              return (
                <div key={vq.id} className="flex justify-between gap-4 border-b border-line/60 pb-2">
                  <dt className="shrink-0 font-bold">{vq.title}</dt>
                  <dd className="text-left text-muted" style={{ whiteSpace: "pre-wrap" }}>
                    {display === "" ? "—" : display}
                  </dd>
                </div>
              );
            })}
          </dl>

          {submitError && (
            <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-danger">
              {submitError}
            </p>
          )}

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={phase === "submitting" || disabled}
              className="flex-1 rounded-full bg-brand px-6 py-3.5 text-lg font-extrabold text-ink shadow transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              {phase === "submitting" ? "שולחים…" : submitLabel}
            </button>
            <button
              type="button"
              onClick={back}
              disabled={phase === "submitting"}
              className="rounded-full border border-line px-5 py-3 font-bold disabled:opacity-60"
            >
              חזרה
            </button>
          </div>
        </section>
      ) : (
        q && (
          <section
            key={q.id}
            aria-label={q.title}
            className={`rounded-3xl border border-line bg-surface p-5 transition-all duration-300 ease-out motion-reduce:transition-none ${
              direction === 1
                ? "animate-[slide-in-rtl_0.3s_ease-out]"
                : "animate-[slide-in-rtl-back_0.3s_ease-out]"
            }`}
          >
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-extrabold outline-none"
            >
              {q.title}
            </h2>
            {q.subtitle && <p className="mt-1 text-sm text-muted">{q.subtitle}</p>}

            <div className="mt-4">
              {q.type === "single-select" && (
                <div role="radiogroup" aria-label={q.title} className="flex flex-col gap-2">
                  {q.options?.map((o) => {
                    const selected = answers[q.id] === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setValue(q.id, o.value)}
                        className={`flex min-h-[56px] items-center justify-between rounded-2xl border-2 px-4 py-3 text-right font-semibold transition-colors ${
                          selected
                            ? "border-brand-dark bg-brand-soft"
                            : "border-line bg-white hover:border-brand-dark/50"
                        }`}
                      >
                        <span>{o.label}</span>
                        {selected && <CheckGlyph />}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === "multi-select" && (
                <div className="flex flex-col gap-2" role="group" aria-label={q.title}>
                  {q.options?.map((o) => {
                    const arr = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
                    const selected = arr.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleMulti(q.id, o.value)}
                        className={`flex min-h-[56px] items-center justify-between rounded-2xl border-2 px-4 py-3 text-right font-semibold transition-colors ${
                          selected
                            ? "border-brand-dark bg-brand-soft"
                            : "border-line bg-white hover:border-brand-dark/50"
                        }`}
                      >
                        <span>{o.label}</span>
                        {selected && <CheckGlyph />}
                      </button>
                    );
                  })}
                </div>
              )}

              {(q.type === "text" || q.type === "textarea") && (
                <>
                  <label htmlFor={`q-${q.id}`} className="sr-only">
                    {q.title}
                  </label>
                  {q.type === "text" ? (
                    <input
                      id={`q-${q.id}`}
                      type="text"
                      value={String(answers[q.id] ?? "")}
                      maxLength={q.maxLength}
                      placeholder={q.placeholder}
                      onChange={(e) => setValue(q.id, e.target.value)}
                      className="w-full rounded-2xl border border-line bg-white px-4 py-3.5 text-[15px]"
                    />
                  ) : (
                    <textarea
                      id={`q-${q.id}`}
                      rows={4}
                      value={String(answers[q.id] ?? "")}
                      maxLength={q.maxLength}
                      placeholder={q.placeholder}
                      onChange={(e) => setValue(q.id, e.target.value)}
                      className="w-full resize-y rounded-2xl border border-line bg-white px-4 py-3.5 text-[15px] leading-7"
                    />
                  )}
                </>
              )}

              {q.type === "datetime" && (
                <>
                  <label htmlFor={`q-${q.id}`} className="sr-only">
                    {q.title}
                  </label>
                  <input
                    id={`q-${q.id}`}
                    type="datetime-local"
                    value={String(answers[q.id] ?? "")}
                    onChange={(e) => setValue(q.id, e.target.value)}
                    className="w-full rounded-2xl border border-line bg-white px-4 py-3.5 text-[15px]"
                  />
                </>
              )}
            </div>

            {questionError && (
              <p role="alert" className="mt-3 text-sm font-semibold text-danger">
                {questionError}
              </p>
            )}

            <div className="mt-6 flex gap-2">
              <button
                type="button"
                onClick={next}
                className="flex-1 rounded-full bg-brand px-6 py-3.5 text-lg font-extrabold text-ink shadow transition-transform active:scale-[0.98]"
              >
                {safeIndex + 1 < visible.length ? "המשך" : "לסיכום"}
              </button>
              <button
                type="button"
                onClick={back}
                className="rounded-full border border-line px-5 py-3 font-bold"
              >
                חזרה
              </button>
            </div>
          </section>
        )
      )}
    </div>
  );
}

function CheckGlyph() {
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-ink"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
        <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
