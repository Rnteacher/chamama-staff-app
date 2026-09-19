"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ConversationalForm, { type Question, type Answers } from "@/components/conversational/ConversationalForm";
import { upsertMeetingScheduleAction, submitMeetingReportAction } from "@/lib/actions/meetings";
import { WEEKDAY_SHORT_LABELS, WEEKDAY_LABELS, schoolWeekStart, isValidTime } from "@/lib/meetings";

export interface ScheduleRow {
  id: string;
  context: "mentor" | "master";
  weekday: number;
  meetingTime: string; // HH:MM
  isActive: boolean;
  staffName: string;
  mine: boolean;
}

export interface ReportableOccurrence {
  occurrenceId: string;
  dueAt: string; // ISO
  context: "mentor" | "master";
}

interface StudentMeetingsPanelProps {
  studentId: string;
  schedules: ScheduleRow[];
  allowedContexts: ("mentor" | "master")[];
  reportable: ReportableOccurrence[];
  initialOccurrenceId?: string;
  autoOpenReport: boolean;
}

const CONTEXT_LABELS: Record<"mentor" | "master", string> = {
  mentor: "מנטור",
  master: "מאסטר",
};

export default function StudentMeetingsPanel({
  studentId,
  schedules,
  allowedContexts,
  reportable,
  initialOccurrenceId,
  autoOpenReport,
}: StudentMeetingsPanelProps) {
  const router = useRouter();
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleRow | null>(null);
  const [reportOpen, setReportOpen] = useState(
    Boolean(autoOpenReport && initialOccurrenceId)
  );
  const [reportOccurrenceId, setReportOccurrenceId] = useState<string | null>(
    initialOccurrenceId ?? reportable[0]?.occurrenceId ?? null
  );

  const activeSchedules = schedules.filter((s) => s.isActive);
  const canReport = reportable.length > 0;
  const reportTarget =
    reportable.find((r) => r.occurrenceId === reportOccurrenceId) ?? reportable[0] ?? null;

  return (
    <section aria-labelledby="meetings-heading" className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="meetings-heading" className="font-extrabold">פגישה שבועית</h2>
        <div className="flex flex-wrap gap-2">
          {allowedContexts.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setScheduleDialogOpen(true);
              }}
              className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-white"
            >
              {schedules.some((s) => s.mine) ? "עריכת הפגישה שלי" : "קביעת פגישה שבועית"}
            </button>
          )}
          <button
            type="button"
            disabled={!canReport}
            onClick={() => {
              setReportOccurrenceId(reportTarget?.occurrenceId ?? null);
              setReportOpen(true);
            }}
            className="rounded-full bg-brand px-4 py-2 text-sm font-extrabold text-ink disabled:opacity-50"
            title={canReport ? undefined : "אין פגישה שטרם דווחה"}
          >
            דיווח פגישה
          </button>
        </div>
      </div>

      {activeSchedules.length === 0 ? (
        <p className="mt-2 text-sm text-muted">טרם נקבעה פגישה שבועית לחניך/ה זה.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {activeSchedules.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-bg px-3 py-2.5 text-sm"
            >
              <span>
                <span className="font-bold">
                  {WEEKDAY_SHORT_LABELS[s.weekday]} · {s.meetingTime}
                </span>
                <span className="text-muted"> · {CONTEXT_LABELS[s.context]}: {s.staffName}</span>
              </span>
              {s.mine && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(s);
                    setScheduleDialogOpen(true);
                  }}
                  className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-bold"
                >
                  עריכה
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!canReport && allowedContexts.length > 0 && schedules.some((s) => s.mine) && (
        <p className="mt-2 text-xs text-muted">
          כל הפגישות שלכם דווחו כרגע. דיווח חדש יהיה זמין בהתקרב מועד הפגישה הבאה.
        </p>
      )}

      <ScheduleDialog
        key={`${editing?.id ?? "new"}-${scheduleDialogOpen}`}
        open={scheduleDialogOpen}
        onClose={() => setScheduleDialogOpen(false)}
        studentId={studentId}
        allowedContexts={allowedContexts}
        editing={editing}
      />

      {reportOpen && reportTarget && (
        <ReportWizard
          occurrence={reportTarget}
          multiple={reportable.length > 1}
          occurrences={reportable}
          onOccurrenceChange={(id) => setReportOccurrenceId(id)}
          onClose={() => {
            setReportOpen(false);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------- schedule --

function ScheduleDialog({
  open,
  onClose,
  studentId,
  allowedContexts,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  studentId: string;
  allowedContexts: ("mentor" | "master")[];
  editing: ScheduleRow | null;
}) {
  const [context, setContext] = useState<"mentor" | "master">(
    editing?.context ?? allowedContexts[0] ?? "mentor"
  );
  const [weekday, setWeekday] = useState<number>(editing?.weekday ?? 0);
  const [time, setTime] = useState<string>(editing?.meetingTime ?? "16:00");
  const [isActive, setIsActive] = useState<boolean>(editing?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);

  // state is initialized from props on mount (the parent re-mounts this
  // component with a key whenever the dialog opens or the target changes)
  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
    }
  }, [open]);

  function save() {
    if (!isValidTime(time)) {
      setError("הזינו שעה בפורמט HH:MM");
      return;
    }
    startTransition(async () => {
      const res = await upsertMeetingScheduleAction({
        studentId,
        context,
        weekday,
        meetingTime: time,
        isActive,
        scheduleId: editing?.id ?? null,
      });
      if (res.ok) {
        onClose();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label="פגישה שבועית"
      className="m-auto w-[min(92vw,26rem)] rounded-3xl border border-line bg-surface p-0"
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-3 p-5"
      >
        <h3 className="text-lg font-extrabold">
          {editing ? "עריכת פגישה שבועית" : "קביעת פגישה שבועית"}
        </h3>

        {allowedContexts.length > 1 && (
          <label className="text-sm">
            הקשר
            <select
              value={context}
              onChange={(e) => setContext(e.target.value as "mentor" | "master")}
              className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5"
            >
              {allowedContexts.map((c) => (
                <option key={c} value={c}>{CONTEXT_LABELS[c]}</option>
              ))}
            </select>
          </label>
        )}

        <label className="text-sm">
          יום בשבוע
          <select
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
            className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5"
          >
            {WEEKDAY_LABELS.map((label, i) => (
              <option key={i} value={i}>{label}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          שעה
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-5 w-5 accent-[#46b800]"
          />
          פגישה פעילה
        </label>

        {error && <p role="alert" className="text-sm font-semibold text-danger">{error}</p>}

        <div className="mt-1 flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded-full bg-brand px-4 py-3 font-extrabold text-ink disabled:opacity-60"
          >
            {pending ? "שומרים…" : "שמירה"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-5 py-3 font-bold"
          >
            ביטול
          </button>
        </div>
      </form>
    </dialog>
  );
}

// ------------------------------------------------------------------ report --

function ReportWizard({
  occurrence,
  multiple,
  occurrences,
  onOccurrenceChange,
  onClose,
}: {
  occurrence: ReportableOccurrence;
  multiple: boolean;
  occurrences: ReportableOccurrence[];
  onOccurrenceChange: (id: string) => void;
  onClose: () => void;
}) {
  const [answers, setAnswers] = useState<Answers>({ held: true });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const occWeekStart = useMemo(
    () => schoolWeekStart(new Date(occurrence.dueAt)),
    [occurrence.dueAt]
  );

  const questions: Question[] = useMemo(
    () => [
      {
        id: "held",
        title: "האם הפגישה התקיימה?",
        type: "single-select",
        options: [
          { value: "yes", label: "התקיימה" },
          { value: "no", label: "לא התקיימה" },
        ],
      },
      {
        id: "not_held_reason",
        title: "מדוע הפגישה לא התקיימה?",
        type: "textarea",
        maxLength: 500,
        placeholder: "למשל: החניך/ה ביטל/ה ברגע האחרון",
        visibleWhen: (a) => a.held === "no",
        validate: (a) =>
          typeof a.not_held_reason === "string" && a.not_held_reason.trim() !== ""
            ? null
            : "נדרשת סיבה",
      },
      {
        id: "reschedule",
        title: "מועד חדש לפגישה (אופציונלי)",
        subtitle: `ניתן לקבוע מועד חדש בתוך אותו שבוע לימודים (${WEEKDAY_SHORT_LABELS[0]}–${WEEKDAY_SHORT_LABELS[6]})`,
        type: "datetime",
        optional: true,
        visibleWhen: (a) => a.held === "no",
        validate: (a) => {
          const v = a.reschedule;
          if (typeof v !== "string" || v === "") return null;
          const [datePart, timePart] = v.split("T");
          if (!datePart || !timePart || !isValidTime(timePart)) {
            return "מועד לא תקין";
          }
          const utc = new Date(v);
          if (schoolWeekStart(utc) !== occWeekStart) {
            return "המועד החדש חייב להישאר באותו שבוע לימודים";
          }
          if (utc.getTime() <= Date.now()) {
            return "המועד החדש חייב להיות בעתיד";
          }
          return null;
        },
      },
      {
        id: "status",
        title: "מה מצב החניך/ה בפרויקט אחרי הפגישה?",
        type: "single-select",
        options: [
          { value: "green", label: "ירוק" },
          { value: "yellow", label: "צהוב" },
          { value: "red", label: "אדום" },
        ],
      },
      {
        id: "intervention",
        title: "האם נדרשת התערבות של מנטור/מאסטר?",
        type: "single-select",
        options: [
          { value: "yes", label: "כן" },
          { value: "no", label: "לא" },
        ],
      },
      {
        id: "categories",
        title: "מהם תחומי ההתערבות?",
        type: "multi-select",
        options: [
          { value: "functional", label: "עניין תפקודי" },
          { value: "emotional", label: "עניין רגשי" },
          { value: "other", label: "אחר" },
        ],
        visibleWhen: (a) => a.intervention === "yes",
      },
      {
        id: "detail_functional",
        title: "פירוט תפקודי",
        type: "textarea",
        maxLength: 1000,
        visibleWhen: (a) =>
          a.intervention === "yes" &&
          Array.isArray(a.categories) &&
          (a.categories as string[]).includes("functional"),
        validate: (a) =>
          typeof a.detail_functional === "string" && a.detail_functional.trim() !== ""
            ? null
            : "נדרש פירוט",
      },
      {
        id: "detail_emotional",
        title: "פירוט רגשי",
        type: "textarea",
        maxLength: 1000,
        visibleWhen: (a) =>
          a.intervention === "yes" &&
          Array.isArray(a.categories) &&
          (a.categories as string[]).includes("emotional"),
        validate: (a) =>
          typeof a.detail_emotional === "string" && a.detail_emotional.trim() !== ""
            ? null
            : "נדרש פירוט",
      },
      {
        id: "detail_other",
        title: "פירוט אחר",
        type: "textarea",
        maxLength: 1000,
        visibleWhen: (a) =>
          a.intervention === "yes" &&
          Array.isArray(a.categories) &&
          (a.categories as string[]).includes("other"),
        validate: (a) =>
          typeof a.detail_other === "string" && a.detail_other.trim() !== ""
            ? null
            : "נדרש פירוט",
      },
      {
        id: "next_steps",
        title: "מה הוחלט בפגישה לקראת הפגישה הבאה?",
        type: "textarea",
        maxLength: 2000,
        optional: answers.held !== "yes",
      },
    ],
    [answers.held, occWeekStart]
  );

  function submit(): Promise<void> {
    return new Promise((resolve, reject) => {
      startTransition(async () => {
        const res = await submitMeetingReportAction({
          occurrenceId: occurrence.occurrenceId,
          held: answers.held === "yes",
          notHeldReason: String(answers.not_held_reason ?? ""),
          rescheduleLocal: String(answers.reschedule ?? ""),
          status: String(answers.status ?? "") as "green" | "yellow" | "red",
          intervention: answers.intervention === "yes",
          categories: Array.isArray(answers.categories)
            ? (answers.categories as ("functional" | "emotional" | "other")[])
            : [],
          detailFunctional: String(answers.detail_functional ?? ""),
          detailEmotional: String(answers.detail_emotional ?? ""),
          detailOther: String(answers.detail_other ?? ""),
          nextSteps: String(answers.next_steps ?? ""),
        });
        if (res.ok) {
          resolve();
        } else {
          setSubmitError(res.error);
          reject(new Error(res.error));
        }
      });
    });
  }

  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto bg-ink/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="דיווח פגישה"
    >
      <div className="mx-auto mt-6 w-full max-w-lg pb-10">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-bold">דיווח פגישה · {CONTEXT_LABELS[occurrence.context]}</p>
            <p className="text-xs text-muted">
              {multiple ? "בחרתם את הפגישה לדיווח" : "פגישה שבועית שטרם דווחה"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירה"
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm font-bold"
          >
            ✕
          </button>
        </div>

        {multiple && (
          <label className="mb-3 block rounded-2xl border border-line bg-surface p-3 text-sm">
            פגישה לדיווח
            <select
              value={occurrence.occurrenceId}
              onChange={(e) => onOccurrenceChange(e.target.value)}
              className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5"
            >
              {occurrences.map((o) => (
                <option key={o.occurrenceId} value={o.occurrenceId}>
                  {WEEKDAY_SHORT_LABELS[new Date(o.dueAt).getDay()]} ·{" "}
                  {new Date(o.dueAt).toLocaleString("he-IL", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </option>
              ))}
            </select>
          </label>
        )}

        <ConversationalForm
          questions={questions}
          answers={answers}
          onAnswersChange={setAnswers}
          onSubmit={submit}
          submitLabel="שליחת הדיווח"
          successText="הדיווח נשלח בהצלחה"
          submitError={submitError}
          disabled={pending}
          onBack={onClose}
        />
      </div>
    </div>
  );
}
