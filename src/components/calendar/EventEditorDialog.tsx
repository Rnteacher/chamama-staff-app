"use client";

import { useActionState, useEffect, useState } from "react";
import {
  upsertCalendarEventAction,
  deleteCalendarEventAction,
} from "@/lib/actions/calendar";
import MultiSelectCheckbox, {
  type MultiSelectOption,
} from "@/components/learning-groups/MultiSelectCheckbox";
import {
  describeRecurrenceHe,
  type RecurrenceKind,
} from "@/lib/schedule";

export interface EditorOptions {
  groups: { id: string; name: string }[];
  majors: { id: string; name: string }[];
  learningGroups: { id: string; name: string; isActive: boolean }[];
  staff: MultiSelectOption[];
}

export interface EditorEventData {
  id: string | null;
  title: string;
  description: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  isAllDay: boolean;
  recurrence: RecurrenceKind;
  recurrenceUntil: string;
  /** audience bindings of the ORIGINAL event (edit mode) */
  audiences: {
    type: "everyone" | "staff_only" | "home_group" | "major" | "learning_group" | "staff_member";
    greenhouseGroupId?: string | null;
    majorId?: string | null;
    learningGroupId?: string | null;
    staffId?: string | null;
  }[];
}

interface AudienceSelection {
  everyone: boolean;
  staffOnly: boolean;
  homeGroupIds: string[];
  majorIds: string[];
  learningGroupIds: string[];
  staffIds: string[];
}

function selectionFrom(audiences: EditorEventData["audiences"]): AudienceSelection {
  const s: AudienceSelection = {
    everyone: false,
    staffOnly: false,
    homeGroupIds: [],
    majorIds: [],
    learningGroupIds: [],
    staffIds: [],
  };
  for (const a of audiences) {
    if (a.type === "everyone") s.everyone = true;
    else if (a.type === "staff_only") s.staffOnly = true;
    else if (a.type === "home_group" && a.greenhouseGroupId)
      s.homeGroupIds.push(a.greenhouseGroupId);
    else if (a.type === "major" && a.majorId) s.majorIds.push(a.majorId);
    else if (a.type === "learning_group" && a.learningGroupId)
      s.learningGroupIds.push(a.learningGroupId);
    else if (a.type === "staff_member" && a.staffId) s.staffIds.push(a.staffId);
  }
  return s;
}

function selectionToJson(s: AudienceSelection): string {
  const out: Record<string, unknown>[] = [];
  if (s.everyone) {
    // "כולם" supersedes every other audience — mutually exclusive by design
    return JSON.stringify([{ type: "everyone" }]);
  }
  if (s.staffOnly) out.push({ type: "staff_only" });
  for (const id of s.homeGroupIds) out.push({ type: "home_group", greenhouse_group_id: id });
  for (const id of s.majorIds) out.push({ type: "major", major_id: id });
  for (const id of s.learningGroupIds) out.push({ type: "learning_group", learning_group_id: id });
  for (const id of s.staffIds) out.push({ type: "staff_member", staff_id: id });
  return JSON.stringify(out);
}

/**
 * Create/edit/delete a calendar event (leadership/super_admin — enforced
 * server-side; this dialog is hidden for read-only viewers).
 */
export default function EventEditorDialog({
  initial,
  options,
  canManage,
  onClose,
}: {
  initial: EditorEventData;
  options: EditorOptions | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const isEdit = initial.id !== null;
  const [state, formAction, pending] = useActionState(
    upsertCalendarEventAction,
    null
  );
  const [delState, delAction, delPending] = useActionState(
    deleteCalendarEventAction,
    null
  );
  const [isAllDay, setIsAllDay] = useState(initial.isAllDay);
  const [recurrence, setRecurrence] = useState<RecurrenceKind>(initial.recurrence);
  const [recurrenceUntil, setRecurrenceUntil] = useState(initial.recurrenceUntil);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [aud, setAud] = useState<AudienceSelection>(selectionFrom(initial.audiences));

  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // close shortly after a successful save/delete (server refreshes the page)
  useEffect(() => {
    if (state?.ok || delState?.ok) {
      const t = setTimeout(() => onClose(), 700);
      return () => clearTimeout(t);
    }
  }, [state, delState, onClose]);

  const summary = describeRecurrenceHe({
    recurrence,
    recurrenceUntil,
    startDate,
  });

  const noAudience =
    !aud.everyone &&
    !aud.staffOnly &&
    aud.homeGroupIds.length === 0 &&
    aud.majorIds.length === 0 &&
    aud.learningGroupIds.length === 0 &&
    aud.staffIds.length === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? "עריכת אירוע" : "אירוע חדש"}
      className="fixed inset-0 z-40 grid place-items-start overflow-y-auto bg-ink/55 p-4 lg:place-items-center"
    >
      <form
        action={formAction}
        className="my-6 w-full max-w-xl rounded-3xl border border-line bg-surface p-6"
      >
        <h3 className="text-lg font-extrabold">
          {isEdit ? "עריכת אירוע" : "אירוע חדש"}
        </h3>

        {canManage ? (
          <>
            <label className="mt-3 block text-sm">
              כותרת
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={initial.title}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
              />
            </label>

            <label className="mt-3 block text-sm">
              תיאור (לא חובה)
              <textarea
                name="description"
                rows={2}
                maxLength={2000}
                defaultValue={initial.description}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
              />
            </label>

            <label className="mt-3 flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                name="isAllDay"
                checked={isAllDay}
                onChange={(e) => setIsAllDay(e.target.checked)}
                className="h-5 w-5 accent-[#46b800]"
              />
              אירוע כל היום
            </label>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-sm">
                תאריך התחלה
                <input
                  type="date"
                  name="startDate"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
                />
              </label>
              {!isAllDay && (
                <label className="block text-sm">
                  שעת התחלה
                  <input
                    type="time"
                    name="startTime"
                    required
                    defaultValue={initial.startTime}
                    className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
                    dir="ltr"
                  />
                </label>
              )}
              <label className="block text-sm">
                תאריך סיום
                <input
                  type="date"
                  name="endDate"
                  required
                  defaultValue={initial.endDate}
                  className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
                />
              </label>
              {!isAllDay && (
                <label className="block text-sm">
                  שעת סיום
                  <input
                    type="time"
                    name="endTime"
                    required
                    defaultValue={initial.endTime}
                    className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
                    dir="ltr"
                  />
                </label>
              )}
            </div>

            <fieldset className="mt-4">
              <legend className="text-sm font-bold">חזרתיות</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {(
                  [
                    ["none", "חד פעמי"],
                    ["weekly", "שבועי"],
                    ["monthly", "חודשי"],
                  ] as [RecurrenceKind, string][]
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${
                      recurrence === value
                        ? "border-brand-dark bg-brand-soft"
                        : "border-line bg-white"
                    }`}
                  >
                    <input
                      type="radio"
                      name="recurrence"
                      value={value}
                      checked={recurrence === value}
                      onChange={() => setRecurrence(value)}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {recurrence !== "none" && (
                <div className="mt-2">
                  <label className="block text-sm">
                    חוזר עד (תאריך כולל)
                    <input
                      type="date"
                      name="recurrenceUntil"
                      required
                      value={recurrenceUntil}
                      min={startDate}
                      onChange={(e) => setRecurrenceUntil(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
                    />
                  </label>
                  <p className="mt-1 text-xs font-semibold text-brand-dark">{summary}</p>
                </div>
              )}
            </fieldset>

            <fieldset className="mt-4">
              <legend className="text-sm font-bold">קהל יעד</legend>
              <div className="mt-1.5 flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={aud.everyone}
                    onChange={(e) =>
                      setAud((prev) => ({ ...prev, everyone: e.target.checked }))
                    }
                    className="h-5 w-5 accent-[#46b800]"
                  />
                  כולם
                </label>
                <label className={`flex items-center gap-2 text-sm font-semibold ${aud.everyone ? "opacity-40" : ""}`}>
                  <input
                    type="checkbox"
                    checked={aud.staffOnly}
                    disabled={aud.everyone}
                    onChange={(e) =>
                      setAud((prev) => ({ ...prev, staffOnly: e.target.checked }))
                    }
                    className="h-5 w-5 accent-[#46b800]"
                  />
                  צוות בלבד
                </label>
              </div>
              {aud.everyone && (
                <p className="mt-1 text-xs text-muted">
                  ״כולם״ כולל את כל הקבוצות והמגמות — אין צורך לבחור ידנית.
                </p>
              )}

              {!aud.everyone && options && (
                <div className="mt-2 flex flex-col gap-3">
                  <MultiSelectCheckbox
                    name="audHomeGroupsDisplay"
                    label="קבוצות אם"
                    options={options.groups.map((g) => ({ id: g.id, label: g.name }))}
                    selectedIds={aud.homeGroupIds}
                    searchable={false}
                  />
                  <MultiSelectCheckbox
                    name="audMajorsDisplay"
                    label="מגמות"
                    options={options.majors.map((g) => ({ id: g.id, label: g.name }))}
                    selectedIds={aud.majorIds}
                    searchable={false}
                  />
                  <MultiSelectCheckbox
                    name="audLearningGroupsDisplay"
                    label="קבוצות למידה"
                    options={options.learningGroups.map((g) => ({
                      id: g.id,
                      label: g.name,
                      hint: g.isActive ? undefined : "לא פעילה",
                    }))}
                    selectedIds={aud.learningGroupIds}
                    searchable={false}
                  />
                  <MultiSelectCheckbox
                    name="audStaffDisplay"
                    label="אנשי צוות ספציפיים"
                    options={options.staff}
                    selectedIds={aud.staffIds}
                  />
                </div>
              )}
            </fieldset>

            <input
              type="hidden"
              name="audiences"
              value={selectionToJson(aud)}
              aria-label="קהלי יעד"
            />
            {noAudience && (
              <p className="mt-1 text-xs font-semibold text-danger">
                בחרו לפחות קהל יעד אחד
              </p>
            )}

            {state && !state.ok && (
              <p role="alert" className="mt-3 text-sm font-semibold text-danger">
                {state.error}
              </p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="submit"
                disabled={pending || noAudience}
                className="flex-1 rounded-full bg-brand px-4 py-3 font-extrabold text-ink disabled:opacity-60"
              >
                {pending ? "שומרים…" : isEdit ? "שמירת שינויים" : "יצירת אירוע"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-line px-5 py-3 font-bold"
              >
                סגירה
              </button>
            </div>

            {isEdit && (
              <div className="mt-4 border-t border-line pt-3">
                {deleteConfirm ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl bg-red-50 p-3 text-sm" role="alertdialog" aria-label="אישור מחיקה">
                    <span className="font-bold text-danger">למחוק את האירוע?</span>
                    <span className="flex gap-1.5">
                      <button
                        type="submit"
                        formAction={delAction}
                        disabled={delPending}
                        className="rounded-full bg-danger px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                      >
                        {delPending ? "מוחק…" : "אישור מחיקה"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(false)}
                        className="rounded-full border border-line px-3 py-1.5 text-xs font-bold"
                      >
                        ביטול
                      </button>
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="rounded-full border border-line px-3 py-1.5 text-xs font-bold text-danger"
                  >
                    מחיקת האירוע
                  </button>
                )}
                {delState && !delState.ok && (
                  <p role="alert" className="mt-1 text-xs font-semibold text-danger">
                    {delState.error}
                  </p>
                )}
              </div>
            )}
            {isEdit && <input type="hidden" name="id" value={initial.id ?? ""} />}
          </>
        ) : (
          <>
            {/* read-only details for non-managers */}
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="font-bold">כותרת</dt>
                <dd>{initial.title}</dd>
              </div>
              {initial.description && (
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">תיאור</dt>
                  <dd className="text-left">{initial.description}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="font-bold">מועד</dt>
                <dd dir="ltr">
                  {initial.startDate} {initial.isAllDay ? "כל היום" : `${initial.startTime}–${initial.endTime}`}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-bold">חזרתיות</dt>
                <dd>{summary}</dd>
              </div>
              {initial.audiences.length > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">קהל יעד</dt>
                  <dd className="text-left">
                    {initial.audiences
                      .map((a) =>
                        a.type === "everyone"
                          ? "כולם"
                          : a.type === "staff_only"
                            ? "צוות בלבד"
                            : a.type === "home_group"
                              ? "קבוצת אם"
                              : a.type === "major"
                                ? "מגמה"
                                : a.type === "learning_group"
                                  ? "קבוצת למידה"
                                  : "צוות"
                      )
                      .join(" · ")}
                  </dd>
                </div>
              )}
            </dl>
            <div className="mt-5">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-line px-5 py-3 font-bold"
              >
                סגירה
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
