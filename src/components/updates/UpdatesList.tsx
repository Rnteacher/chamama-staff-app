"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  markMessagesReadAction,
  markMessagesUnreadAction,
} from "@/lib/actions/messages";
import { timeAgo } from "@/lib/format";

export interface UpdateItem {
  message_id: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  author_name: string | null;
  body: string;
  created_at: string;
  read: boolean;
}

type Tab = "all" | "unread" | "read";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "הכל" },
  { key: "unread", label: "לא נקראו" },
  { key: "read", label: "נקראו" },
];

export default function UpdatesList({ items }: { items: UpdateItem[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("all");
  const [readMap, setReadMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(items.map((i) => [i.message_id, i.read]))
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const setRead = (id: string, value: boolean) => {
    const prev = readMap[id] ?? true;
    setReadMap((p) => ({ ...p, [id]: value }));
    startTransition(async () => {
      const res = value
        ? await markMessagesReadAction({ messageIds: [id] })
        : await markMessagesUnreadAction({ messageIds: [id] });
      if (res.ok) {
        setError(null);
        router.refresh();
      } else {
        setReadMap((p) => ({ ...p, [id]: prev }));
        setError(res.error);
      }
    });
  };

  const unreadIds = useMemo(
    () => items.filter((i) => !(readMap[i.message_id] ?? true)).map((i) => i.message_id),
    [items, readMap]
  );

  const visible = useMemo(() => {
    if (tab === "all") return items;
    if (tab === "unread") return items.filter((i) => !(readMap[i.message_id] ?? true));
    return items.filter((i) => readMap[i.message_id] ?? true);
  }, [items, tab, readMap]);

  const unreadCount = unreadIds.length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-extrabold">עדכונים</h1>
        {unreadCount > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await markMessagesReadAction({ messageIds: unreadIds });
                if (res.ok) {
                  setReadMap(Object.fromEntries(items.map((i) => [i.message_id, true])));
                  router.refresh();
                } else setError(res.error);
              })
            }
            className="rounded-full border border-line px-4 py-1.5 text-sm font-bold text-muted hover:bg-bg disabled:opacity-60"
          >
            סמן הכל כנקרא ({unreadCount})
          </button>
        )}
      </div>

      <div className="flex gap-2" role="group" aria-label="סינון מצב קריאה">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full border px-4 py-1.5 text-sm font-bold transition-colors ${
              tab === t.key
                ? "border-brand-dark bg-brand-soft text-ink"
                : "border-line bg-surface text-muted hover:bg-bg"
            }`}
          >
            {t.label}
            {t.key === "unread" && unreadCount > 0 && (
              <span className="mr-1.5 rounded-full bg-brand px-1.5 text-xs font-extrabold text-ink">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-sm font-semibold text-danger">{error}</p>}

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted">
          {tab === "unread" ? "כל העדכונים הרלוונטיים אליכם נקראו." : "אין עדכונים להצגה."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((row) => {
            const isRead = readMap[row.message_id] ?? true;
            return (
              <li key={row.message_id}>
                <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
                  {!isRead && (
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-dark" />
                  )}
                  <Link
                    href={`/students/${row.student_id}?m=${row.message_id}`} prefetch={false}
                    className="min-w-0 flex-1"
                  >
                    <span className="block font-bold">
                      {row.student_first_name} {row.student_last_name}
                    </span>
                    <span className="mt-0.5 block text-sm leading-6 text-ink/90 line-clamp-3">
                      {row.body}
                    </span>
                    <span className="mt-1 block text-xs text-muted">
                      {row.author_name ?? "צוות"} · {timeAgo(row.created_at)}
                    </span>
                  </Link>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setRead(row.message_id, !isRead)}
                    aria-pressed={!isRead}
                    className="shrink-0 self-center rounded-full border border-line px-3 py-1 text-xs font-bold text-muted hover:bg-bg disabled:opacity-60"
                  >
                    {isRead ? "סמן כלא נקרא" : "סמן כנקרא"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
