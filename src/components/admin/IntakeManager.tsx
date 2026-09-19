"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createIntakeWindowAction,
  revokeIntakeWindowAction,
  assignMasterFromIntakeAction,
  type IntakeCreateResult,
} from "@/lib/actions/intake";
import type { ActionState } from "@/lib/actions/messages";

export interface IntakeWindowRow {
  id: string;
  title: string;
  opensAt: string;
  closesAt: string;
  isRevoked: boolean;
  createdByName: string | null;
}

export interface IntakeSubmissionRow {
  id: string;
  intakeId: string;
  intentText: string;
  majorName: string | null;
  requestedMasterName: string;
  requestedMasterId: string;
  assignedMasterId: string | null;
  studentName: string;
  groupId: string | null;
  groupName: string | null;
  updatedAt: string;
}

function windowStatus(w: IntakeWindowRow): { label: string; cls: string } {
  if (w.isRevoked) return { label: "מבוטל", cls: "border-warn text-warn" };
  const now = Date.now();
  if (now < new Date(w.opensAt).getTime())
    return { label: "טרם נפתח", cls: "border-line text-muted" };
  if (now > new Date(w.closesAt).getTime())
    return { label: "נסגר", cls: "border-line text-muted" };
  return { label: "פתוח", cls: "border-brand-dark bg-brand-soft text-ink" };
}

export default function IntakeManager({
  windows,
  submissions,
  staff,
  groups,
  majors,
}: {
  windows: IntakeWindowRow[];
  submissions: IntakeSubmissionRow[];
  staff: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  majors: { id: string; name: string }[];
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState("");
  const [majorFilter, setMajorFilter] = useState("");
  const [windowFilter, setWindowFilter] = useState("");

  const filtered = submissions.filter((s) => {
    if (groupFilter && s.groupId !== groupFilter) return false;
    if (majorFilter) {
      if (majorFilter === "none") {
        if (s.majorName !== null) return false;
      } else if (s.majorName !== majors.find((m) => m.id === majorFilter)?.name) {
        return false;
      }
    }
    return true;
  });

  const visibleSubmissions = windowFilter
    ? filtered.filter((s) => s.intakeId === windowFilter)
    : filtered;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-extrabold">טפסי קבלה ציבוריים</h2>
            <p className="mt-1 text-sm text-muted">
              קישור ציבורי מוגבל בזמן להצהרות כוונות של חניכים. הקישור מוצג
              פעם אחת בעת היצירה — שמרו אותו לפני סגירת החלון.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-white"
          >
            יצירת טופס חדש
          </button>
        </div>

        {windows.length === 0 ? (
          <p className="mt-3 text-sm text-muted">טרם נוצרו טפסי קבלה.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {windows.map((w) => {
              const st = windowStatus(w);
              return (
                <li
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bg px-3 py-2.5 text-sm"
                >
                  <span>
                    <span className="font-bold">{w.title}</span>
                    <span className="text-muted">
                      {" "}
                      · {new Date(w.opensAt).toLocaleString("he-IL")} →{" "}
                      {new Date(w.closesAt).toLocaleString("he-IL")}
                      {w.createdByName ? ` · נוצר על ידי ${w.createdByName}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${st.cls}`}>
                      {st.label}
                    </span>
                    {!w.isRevoked && (
                      <RevokeButton id={w.id} />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">הצהרות שהתקבלו ({visibleSubmissions.length})</h2>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <label className="text-xs font-semibold text-muted">
            קבוצה
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="mr-2 rounded-xl border border-line bg-white px-3 py-2"
            >
              <option value="">הכל</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-muted">
            מגמה
            <select
              value={majorFilter}
              onChange={(e) => setMajorFilter(e.target.value)}
              className="mr-2 rounded-xl border border-line bg-white px-3 py-2"
            >
              <option value="">הכל</option>
              <option value="none">לא במגמה</option>
              {majors.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-muted">
            טופס
            <select
              value={windowFilter}
              onChange={(e) => setWindowFilter(e.target.value)}
              className="mr-2 rounded-xl border border-line bg-white px-3 py-2"
            >
              <option value="">הכל</option>
              {windows.map((w) => (
                <option key={w.id} value={w.id}>{w.title}</option>
              ))}
            </select>
          </label>
        </div>

        {visibleSubmissions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">אין הצהרות להצגה.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[900px] text-right text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="py-2 pl-2 font-semibold">קבוצה</th>
                  <th scope="col" className="py-2 font-semibold">חניך/ה</th>
                  <th scope="col" className="py-2 font-semibold">הצהרת כוונות</th>
                  <th scope="col" className="py-2 font-semibold">מגמה</th>
                  <th scope="col" className="py-2 font-semibold">מאסטר/ית מבוקש/ת</th>
                  <th scope="col" className="py-2 font-semibold">מאסטר/ית שנקבע/ה</th>
                  <th scope="col" className="py-2 pr-2 font-semibold">עודכן</th>
                </tr>
              </thead>
              <tbody>
                {visibleSubmissions.map((s) => (
                  <SubmissionRow key={s.id} row={s} staff={staff} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(token) => {
            setCreateOpen(false);
            setCreatedLink(
              `${window.location.origin}/intake/${token}`
            );
          }}
        />
      )}

      {createdLink && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="הקישור הציבורי"
          className="fixed inset-0 z-40 grid place-items-center bg-ink/55 p-4"
        >
          <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 text-center">
            <h3 className="text-lg font-extrabold">הטופס נוצר</h3>
            <p className="mt-2 text-sm leading-6 text-muted">
              זהו הקישור הציבורי. הוא מוצג <strong>פעם אחת בלבד</strong> — העתיקו
              ושמרו אותו כעת (למשל בשיתוף עם החניכים).
            </p>
            <div dir="ltr" className="mt-3 break-all rounded-xl bg-bg p-3 text-xs">
              {createdLink}
            </div>
            <div className="mt-4 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(createdLink);
                }}
                className="rounded-full bg-brand px-5 py-2.5 text-sm font-extrabold text-ink"
              >
                העתקה
              </button>
              <button
                type="button"
                onClick={() => setCreatedLink(null)}
                className="rounded-full border border-line px-5 py-2.5 text-sm font-bold"
              >
                סגירה
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RevokeButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const fd = new FormData();
          fd.set("id", id);
          await revokeIntakeWindowAction(null, fd);
          router.refresh();
        })
      }
      className="rounded-full border border-line px-3 py-1 text-xs font-bold text-danger disabled:opacity-60"
    >
      השבתה
    </button>
  );
}

function SubmissionRow({
  row,
  staff,
}: {
  row: IntakeSubmissionRow;
  staff: { id: string; name: string }[];
}) {
  const [selected, setSelected] = useState(row.assignedMasterId ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <tr className="border-b border-line/60 last:border-0 align-top">
      <td className="py-3 pl-2 text-muted">{row.groupName ?? "—"}</td>
      <td className="py-3 font-bold">{row.studentName}</td>
      <td className="max-w-[260px] py-3 text-muted">{row.intentText}</td>
      <td className="py-3 text-muted">
        {row.majorName ?? <span className="font-semibold">לא במגמה</span>}
      </td>
      <td className="py-3">
        {row.requestedMasterName}
        {row.requestedMasterId !== row.assignedMasterId && (
          <span className="mr-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold">
            הצעת החניך/ה
          </span>
        )}
      </td>
      <td className="py-3">
        <div className="flex items-center gap-2">
          <select
            aria-label={`מאסטר/ית שנקבע/ה עבור ${row.studentName}`}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setSaved(false);
            }}
            className="rounded-xl border border-line bg-white px-2 py-1.5 text-xs"
          >
            <option value="">— טרם שויך —</option>
            {staff.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === row.requestedMasterId ? " ★" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || !selected}
            onClick={() =>
              startTransition(async () => {
                const fd = new FormData();
                fd.set("submissionId", row.id);
                fd.set("masterStaffId", selected);
                const res: ActionState = await assignMasterFromIntakeAction(null, fd);
                if (res.ok) {
                  setSaved(true);
                  setError(null);
                  router.refresh();
                } else {
                  setSaved(false);
                  setError(res.error);
                }
              })
            }
            className="rounded-full bg-ink px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
          >
            {pending ? "…" : "שיבוץ"}
          </button>
        </div>
        {saved && <p className="mt-1 text-[11px] font-bold text-brand-dark">שויך</p>}
        {error && <p role="alert" className="mt-1 text-[11px] font-bold text-danger">{error}</p>}
      </td>
      <td className="py-3 pr-2 text-xs text-muted">
        {new Date(row.updatedAt).toLocaleString("he-IL")}
      </td>
    </tr>
  );
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<IntakeCreateResult | null>(null);

  function submit(fd: FormData) {
    startTransition(async () => {
      const res = await createIntakeWindowAction(null, fd);
      if (res.ok) {
        onCreated(res.token ?? "");
      } else {
        setError(res.error);
        setState(res);
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="יצירת טופס קבלה"
      className="fixed inset-0 z-40 grid place-items-center bg-ink/55 p-4"
    >
      <form
        action={submit}
        className="w-full max-w-md rounded-3xl border border-line bg-surface p-6"
      >
        <h3 className="text-lg font-extrabold">טופס קבלה חדש</h3>
        <label className="mt-3 block text-sm">
          כותרת
          <input
            name="title"
            required
            maxLength={120}
            placeholder="למשל: הצהרות כוונות — מחזור תשפ״ו"
            className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
          />
        </label>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            נפתח
            <input
              name="opensAt"
              type="datetime-local"
              required
              className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
            />
          </label>
          <label className="block text-sm">
            נסגר
            <input
              name="closesAt"
              type="datetime-local"
              required
              className="mt-1 w-full rounded-xl border border-line px-3 py-2.5"
            />
          </label>
        </div>
        {error && <p role="alert" className="mt-3 text-sm font-semibold text-danger">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded-full bg-brand px-4 py-3 font-extrabold text-ink disabled:opacity-60"
          >
            {pending ? "יוצרים…" : "יצירה"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-5 py-3 font-bold"
          >
            ביטול
          </button>
        </div>
        {state?.ok && null}
      </form>
    </div>
  );
}
