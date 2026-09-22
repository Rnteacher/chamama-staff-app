"use client";

import { useActionState, useState } from "react";
import {
  upsertEmploymentPlacementAction,
  endEmploymentPlacementAction,
} from "@/lib/actions/employment";
import { formatWorkSlotsHe } from "@/lib/employment";
import { WEEKDAY_NAMES_HE } from "@/lib/schedule";

export interface PlacementEditorData {
  studentId: string;
  studentName: string;
  placement: {
    id: string;
    workplace_name: string;
    contact_name: string | null;
    contact_phone: string | null;
    start_date: string;
    end_date: string | null;
    is_active: boolean;
    notes: string | null;
  } | null;
  weeklySlots: { weekday: number; start_time: string; end_time: string }[];
  eligible: boolean;
  /** youngest-cohort note or invalid-group-name warning (canonical SQL) */
  cohortNote: string | null;
}

interface SlotDraft {
  weekday: number;
  startTime: string;
  endTime: string;
}

/** Jerusalem "today" for the default placement start date. */
function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Create/edit the current placement + planned weekly work days.
 * Editing an existing (possibly ended) placement updates it in place;
 * "סיום שיבוץ" ends it while preserving history.
 * readOnly (View-As): renders placement details without any mutation control.
 */
export default function PlacementEditor({
  data,
  readOnly = false,
}: {
  data: PlacementEditorData;
  readOnly?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    upsertEmploymentPlacementAction,
    null
  );
  const [endState, endAction, endPending] = useActionState(
    endEmploymentPlacementAction,
    null
  );
  const [slots, setSlots] = useState<SlotDraft[]>(
    data.weeklySlots.length > 0
      ? data.weeklySlots.map((s) => ({
          weekday: s.weekday,
          startTime: s.start_time.slice(0, 5),
          endTime: s.end_time.slice(0, 5),
        }))
      : [{ weekday: 2, startTime: "08:30", endTime: "15:00" }]
  );

  if (readOnly) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">שיבוץ לעבודה (צפייה בלבד)</h2>
        {data.placement ? (
          <>
            <dl className="mt-2 flex flex-col gap-1 text-sm">
              <div className="flex gap-1"><dt className="font-bold">מקום עבודה:</dt><dd className="text-muted">{data.placement.workplace_name}</dd></div>
              <div className="flex gap-1"><dt className="font-bold">תקופה:</dt><dd className="text-muted" dir="ltr">{data.placement.start_date} → {data.placement.end_date ?? "—"}</dd></div>
              {data.weeklySlots.length > 0 && (
                <div className="flex gap-1"><dt className="font-bold">ימי עבודה:</dt><dd className="text-muted">{formatWorkSlotsHe(data.weeklySlots)}</dd></div>
              )}
            </dl>
            <p className="mt-2 text-xs font-semibold text-warn">לא זמין במצב צפייה</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">אין שיבוץ לעבודה.</p>
        )}
      </section>
    );
  }

  function addSlot() {
    setSlots((prev) => [...prev, { weekday: 3, startTime: "08:30", endTime: "15:00" }]);
  }
  function removeSlot(i: number) {
    setSlots((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateSlot(i: number, patch: Partial<SlotDraft>) {
    setSlots((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  if (!data.eligible) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">שיבוץ לעבודה</h2>
        <p className="mt-2 text-sm text-muted">
          {data.cohortNote
            ? `${data.cohortNote}. לא ניתן לשבץ לעבודה.`
            : "ניתן לשבץ לעבודה רק חניכים משנתונים פעילים שאינם הצעיר שבהם. הזכאות נגזרת אוטומטית מסדר השנתון של הקבוצה."}
        </p>
      </section>
    );
  }

  const isActivePlacement = data.placement?.is_active ?? false;

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-extrabold">
          {data.placement ? "עריכת שיבוץ לעבודה" : "שיבוץ חדש לעבודה"}
        </h2>
        {data.placement && (
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-bold ${
              isActivePlacement ? "bg-brand-soft" : "border border-warn text-warn"
            }`}
          >
            {isActivePlacement ? "שיבוץ פעיל" : "שיבוץ שהסתיים (היסטוריה)"}
          </span>
        )}
      </div>

      {data.placement && (
        <p className="mt-1 text-xs text-muted" dir="rtl">
          {formatWorkSlotsHe(data.weeklySlots)}
        </p>
      )}

      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="studentId" value={data.studentId} />
        {data.placement && (
          <input type="hidden" name="placementId" value={data.placement.id} />
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            מקום עבודה
            <input
              name="workplaceName"
              required
              maxLength={120}
              defaultValue={data.placement?.workplace_name ?? ""}
              className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
            />
          </label>
          <label className="block text-sm">
            איש/אשת קשר (לא חובה)
            <input
              name="contactName"
              maxLength={120}
              defaultValue={data.placement?.contact_name ?? ""}
              className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
            />
          </label>
          <label className="block text-sm">
            טלפון (לא חובה)
            <input
              name="contactPhone"
              maxLength={30}
              dir="ltr"
              defaultValue={data.placement?.contact_phone ?? ""}
              className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
              תחילת שיבוץ
              <input
                type="date"
                name="startDate"
                required
                defaultValue={data.placement?.start_date ?? todayISO()}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
              />
            </label>
            <label className="block text-sm">
              סיום (לא חובה)
              <input
                type="date"
                name="endDate"
                defaultValue={data.placement?.end_date ?? ""}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
              />
            </label>
          </div>
        </div>

        <fieldset className="rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-bold">ימי עבודה מתוכננים</legend>
          <ul className="flex flex-col gap-2">
            {slots.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <select
                  value={s.weekday}
                  onChange={(e) => updateSlot(i, { weekday: Number(e.target.value) })}
                  aria-label={`יום בשבוע ${i + 1}`}
                  className="rounded-lg border border-line bg-white px-2 py-1.5"
                >
                  {WEEKDAY_NAMES_HE.map((name, wd) => (
                    <option key={wd} value={wd}>יום {name}</option>
                  ))}
                </select>
                <input
                  type="time"
                  value={s.startTime}
                  onChange={(e) => updateSlot(i, { startTime: e.target.value })}
                  aria-label={`שעת התחלה ${i + 1}`}
                  dir="ltr"
                  className="rounded-lg border border-line px-2 py-1.5"
                />
                <span aria-hidden="true">–</span>
                <input
                  type="time"
                  value={s.endTime}
                  onChange={(e) => updateSlot(i, { endTime: e.target.value })}
                  aria-label={`שעת סיום ${i + 1}`}
                  dir="ltr"
                  className="rounded-lg border border-line px-2 py-1.5"
                />
                <button
                  type="button"
                  onClick={() => removeSlot(i)}
                  className="rounded-full border border-line px-2.5 py-1 text-xs font-bold text-danger"
                  disabled={slots.length === 1}
                >
                  הסרה
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={addSlot}
            className="mt-2 rounded-full border border-line px-3 py-1.5 text-xs font-bold hover:bg-brand-soft/40"
          >
            + יום עבודה
          </button>
          <input type="hidden" name="slots" value={JSON.stringify(slots)} />
        </fieldset>

        <label className="block text-sm">
          הערות (לא חובה)
          <textarea
            name="notes"
            rows={2}
            maxLength={1000}
            defaultValue={data.placement?.notes ?? ""}
            className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
          />
        </label>

        {state && !state.ok && (
          <p role="alert" className="text-sm font-semibold text-danger">{state.error}</p>
        )}
        {state?.ok && (
          <p role="status" className="text-sm font-semibold text-brand-dark">הפעולה בוצעה</p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-ink px-5 py-2.5 text-sm font-extrabold text-white disabled:opacity-60"
          >
            {pending ? "שומרים…" : data.placement ? "שמירת שינויים" : "יצירת שיבוץ"}
          </button>
        </div>
      </form>

      {data.placement && isActivePlacement && (
        <form action={endAction} className="mt-4 border-t border-line pt-3">
          <input type="hidden" name="placementId" value={data.placement.id} />
          <input type="hidden" name="studentId" value={data.studentId} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              סיום שיבוץ בתאריך
              <input
                type="date"
                name="endDate"
                className="mr-1 rounded-xl border border-line px-3 py-2"
              />
            </label>
            <button
              type="submit"
              disabled={endPending}
              className="rounded-full border border-line px-4 py-2 text-sm font-bold text-danger disabled:opacity-60"
            >
              {endPending ? "מעבד…" : "סיום שיבוץ"}
            </button>
          </div>
          {endState && !endState.ok && (
            <p role="alert" className="mt-2 text-sm font-semibold text-danger">{endState.error}</p>
          )}
          {endState?.ok && (
            <p role="status" className="mt-2 text-sm font-semibold text-brand-dark">השיבוץ הסתיים</p>
          )}
        </form>
      )}
    </section>
  );
}
