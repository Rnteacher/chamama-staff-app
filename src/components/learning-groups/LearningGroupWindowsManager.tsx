"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createLearningGroupWindowAction,
  revokeLearningGroupWindowAction,
  deleteLearningGroupWindowAction,
  copyLearningGroupLinkAction,
} from "@/lib/actions/learning-groups";
import { buildLgregPublicUrl } from "@/lib/lgreg-public-path";

export interface LgregWindowRow {
  id: string;
  title: string;
  opensAt: string;
  closesAt: string;
  isRevoked: boolean;
  hasRecoverableLink: boolean;
  groupNames: string[];
  createdByName: string | null;
}

function windowStatus(w: LgregWindowRow): { label: string; cls: string } {
  if (w.isRevoked) return { label: "מושבת", cls: "border-warn text-warn" };
  const now = Date.now();
  if (now < new Date(w.opensAt).getTime())
    return { label: "טרם נפתח", cls: "border-line text-muted" };
  if (now > new Date(w.closesAt).getTime())
    return { label: "נסגר", cls: "border-line text-muted" };
  return { label: "פתוח", cls: "border-brand-dark bg-brand-soft text-ink" };
}

/**
 * Management screen for public learning-group registration windows:
 * leadership/super_admin create windows (title + open/close times +
 * selectable learning groups) and copy the FULL absolute public link.
 */
export default function LearningGroupWindowsManager({
  windows,
  learningGroups,
}: {
  windows: LgregWindowRow[];
  learningGroups: { id: string; name: string; isActive: boolean }[];
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-extrabold">חלונות הרשמה ציבוריים</h2>
          <p className="mt-1 text-sm text-muted">
            קישור ציבורי (ללא התחברות) להרשמת חניכים לקבוצות למידה, עם מניעת
            חפיפות בין קבוצות. ניתן להעתיק את הקישור בכל עת, להשבית ולמחוק.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-white"
        >
          חלון הרשמה חדש
        </button>
      </div>

      {windows.length === 0 ? (
        <p className="text-sm text-muted">טרם נוצרו חלונות הרשמה.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {windows.map((w) => {
            const st = windowStatus(w);
            return (
              <li
                key={w.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bg px-3 py-2.5 text-sm lg:flex-nowrap"
              >
                <span className="min-w-0">
                  <span className="font-bold">{w.title}</span>
                  <span className="text-muted">
                    {" "}
                    · {new Date(w.opensAt).toLocaleString("he-IL")} →{" "}
                    {new Date(w.closesAt).toLocaleString("he-IL")}
                    {w.createdByName ? ` · נוצר על ידי ${w.createdByName}` : ""}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    קבוצות: {w.groupNames.length > 0 ? w.groupNames.join(", ") : "—"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${st.cls}`}>
                    {st.label}
                  </span>
                  {w.hasRecoverableLink && <CopyLinkButton windowId={w.id} />}
                  {!w.isRevoked && <RevokeButton id={w.id} />}
                  <DeleteButton id={w.id} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {createOpen && (
        <CreateDialog
          learningGroups={learningGroups}
          onClose={() => setCreateOpen(false)}
          onCreated={(token) => {
            setCreateOpen(false);
            setCreatedLink(buildLgregPublicUrl(token, window.location.origin));
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
            <h3 className="text-lg font-extrabold">חלון ההרשמה נוצר</h3>
            <p className="mt-2 text-sm leading-6 text-muted">
              זהו הקישור הציבורי. הוא מוצג <strong>פעם אחת בלבד</strong> — העתיקו
              ושמרו אותו כעת. ניתן להעתיק אותו שוב בכל עת בעזרת ״העתקת קישור״.
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

function CopyLinkButton({ windowId }: { windowId: string }) {
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await copyLearningGroupLinkAction(windowId);
          if (res.ok && res.token) {
            // build the COMPLETE absolute URL for the CURRENT environment
            const link = buildLgregPublicUrl(res.token, window.location.origin);
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        })
      }
      className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted hover:bg-bg"
      title="העתקת הקישור הציבורי"
    >
      {copied ? "הועתק ✓" : "העתקת קישור"}
    </button>
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
          await revokeLearningGroupWindowAction(null, fd);
          router.refresh();
        })
      }
      className="rounded-full border border-line px-3 py-1 text-xs font-bold text-danger disabled:opacity-60"
    >
      השבתה
    </button>
  );
}

function DeleteButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm("למחוק את חלון ההרשמה? חלון עם הרשמות שהתקבלו יוסר מהרשימה אך ההיסטוריה תישמר.")) return;
        startTransition(async () => {
          const fd = new FormData();
          fd.set("id", id);
          await deleteLearningGroupWindowAction(null, fd);
          router.refresh();
        });
      }}
      className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted hover:bg-red-50 disabled:opacity-60"
    >
      מחיקה
    </button>
  );
}

function CreateDialog({
  learningGroups,
  onClose,
  onCreated,
}: {
  learningGroups: { id: string; name: string; isActive: boolean }[];
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const selectable = learningGroups.filter((g) => g.isActive);

  function submit(fd: FormData) {
    startTransition(async () => {
      const res = await createLearningGroupWindowAction(null, fd);
      if (res.ok) {
        onCreated(res.token ?? "");
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="יצירת חלון הרשמה"
      className="fixed inset-0 z-40 grid place-items-center bg-ink/55 p-4"
    >
      <form
        action={submit}
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-line bg-surface p-6"
      >
        <h3 className="text-lg font-extrabold">חלון הרשמה חדש</h3>
        <label className="mt-3 block text-sm">
          כותרת
          <input
            name="title"
            required
            maxLength={120}
            placeholder="למשל: הרשמה לקבוצות למידה — סמסטר א׳"
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
        <fieldset className="mt-4">
          <legend className="text-sm font-bold">קבוצות למידה שניתן לבחור</legend>
          <div className="mt-1.5 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-xl border border-line bg-white p-2 sm:grid-cols-2">
            {selectable.length === 0 ? (
              <p className="text-sm text-muted">
                אין קבוצות למידה פעילות — צרו קבוצה קודם.
              </p>
            ) : (
              selectable.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="learningGroupIds"
                    value={g.id}
                    className="h-5 w-5 accent-[#46b800]"
                  />
                  <span>{g.name}</span>
                </label>
              ))
            )}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="mt-3 text-sm font-semibold text-danger">
            {error}
          </p>
        )}
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
      </form>
    </div>
  );
}
