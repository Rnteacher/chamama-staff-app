"use client";

import { useActionState, useState } from "react";
import { upsertLearningGroupAction } from "@/lib/actions/learning-groups";
import MultiSelectCheckbox, {
  type MultiSelectOption,
} from "@/components/learning-groups/MultiSelectCheckbox";
import { WEEKDAY_NAMES_HE } from "@/lib/schedule";

export interface LearningGroupFormSlot {
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface LearningGroupFormValues {
  id?: string;
  name: string;
  description: string;
  isActive: boolean;
  slots: LearningGroupFormSlot[];
  staffLeaderIds: string[];
  studentLeaderIds: string[];
}

export const EMPTY_LEARNING_GROUP: LearningGroupFormValues = {
  name: "",
  description: "",
  isActive: true,
  slots: [{ weekday: 0, startTime: "16:00", endTime: "17:30" }],
  staffLeaderIds: [],
  studentLeaderIds: [],
};

/**
 * Create/edit a learning group: name, 1+ weekly slots (add/remove rows),
 * multiple staff leaders and multiple student leaders.
 * Server-side validation + authorization happen in the RPC.
 */
export default function LearningGroupForm({
  values = EMPTY_LEARNING_GROUP,
  staffOptions,
  studentOptions,
  submitLabel = "שמירה",
}: {
  values?: LearningGroupFormValues;
  staffOptions: MultiSelectOption[];
  studentOptions: MultiSelectOption[];
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(
    upsertLearningGroupAction,
    null
  );
  const [slots, setSlots] = useState<LearningGroupFormSlot[]>(
    values.slots.length > 0 ? values.slots : EMPTY_LEARNING_GROUP.slots
  );

  function updateSlot(i: number, patch: Partial<LearningGroupFormSlot>) {
    setSlots((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s))
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {values.id && <input type="hidden" name="id" value={values.id} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          שם הקבוצה
          <input
            name="name"
            required
            maxLength={120}
            defaultValue={values.name}
            className="mt-1 w-full rounded-xl border border-line px-3 py-2"
          />
        </label>
        <label className="flex items-center gap-2 self-end text-sm font-semibold">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={values.isActive}
            className="h-5 w-5 accent-[#46b800]"
          />
          קבוצה פעילה
        </label>
      </div>

      <label className="text-sm">
        תיאור (לא חובה)
        <input
          name="description"
          maxLength={500}
          defaultValue={values.description}
          className="mt-1 w-full rounded-xl border border-line px-3 py-2"
        />
      </label>

      <fieldset>
        <legend className="text-sm font-bold">
          מפגשים שבועיים (חובה — לפחות אחד)
        </legend>
        <div className="mt-1.5 flex flex-col gap-2">
          {slots.map((slot, i) => (
            <div
              key={i}
              className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-white p-2"
            >
              <label className="text-xs font-semibold">
                יום
                <select
                  name="slotWeekday"
                  value={slot.weekday}
                  onChange={(e) => updateSlot(i, { weekday: Number(e.target.value) })}
                  className="mt-0.5 block rounded-lg border border-line px-2 py-1.5 text-sm"
                >
                  {WEEKDAY_NAMES_HE.map((name, wd) => (
                    <option key={wd} value={wd}>
                      יום {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold">
                התחלה
                <input
                  type="time"
                  name="slotStart"
                  value={slot.startTime}
                  onChange={(e) => updateSlot(i, { startTime: e.target.value })}
                  className="mt-0.5 block rounded-lg border border-line px-2 py-1.5 text-sm"
                  dir="ltr"
                />
              </label>
              <label className="text-xs font-semibold">
                סיום
                <input
                  type="time"
                  name="slotEnd"
                  value={slot.endTime}
                  onChange={(e) => updateSlot(i, { endTime: e.target.value })}
                  className="mt-0.5 block rounded-lg border border-line px-2 py-1.5 text-sm"
                  dir="ltr"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setSlots((prev) =>
                    prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev
                  )
                }
                disabled={slots.length <= 1}
                className="rounded-full border border-line px-3 py-1.5 text-xs font-bold text-danger disabled:opacity-40"
              >
                הסרה
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            setSlots((prev) => [
              ...prev,
              { weekday: 0, startTime: "16:00", endTime: "17:30" },
            ])
          }
          className="mt-2 rounded-full border border-line px-3 py-1.5 text-xs font-bold hover:bg-brand-soft/40"
        >
          + הוספת מפגש
        </button>
      </fieldset>

      <MultiSelectCheckbox
        name="staffLeaderIds"
        label="מדריכים (צוות) — אפשר לבחור יותר מאחד"
        options={staffOptions}
        selectedIds={values.staffLeaderIds}
      />

      <MultiSelectCheckbox
        name="studentLeaderIds"
        label="מובילים (חניכים) — אפשר לבחור יותר מאחד"
        options={studentOptions}
        selectedIds={values.studentLeaderIds}
      />

      {state && !state.ok && (
        <p role="alert" className="text-sm font-semibold text-danger">
          {state.error}
        </p>
      )}
      {state && state.ok && (
        <p role="status" className="text-sm font-semibold text-brand-dark">
          הפעולה בוצעה
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-white disabled:opacity-60"
        >
          {pending ? "מעבד…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
