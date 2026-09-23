"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  loadUpdatesPageAction,
  markAllUpdatesReadAction,
  markMessagesReadAction,
  markMessagesUnreadAction,
} from "@/lib/actions/messages";
import { timeAgo } from "@/lib/format";
import type {
  UpdateItem,
  UpdatesCursor,
  UpdatesFilter,
} from "@/lib/updates-types";

export type { UpdateItem } from "@/lib/updates-types";

const TABS: { key: UpdatesFilter; label: string }[] = [
  { key: "all", label: "הכל" },
  { key: "unread", label: "לא נקראו" },
  { key: "read", label: "נקראו" },
];

/**
 * /updates list. Filtering and paging are server-side: each tab loads its
 * own first page (?filter=), "טען עוד" fetches the next keyset page, and
 * "סמן הכל כנקרא" marks the whole unread set in the database. The unread
 * total is the canonical count (same as the nav badge), not the loaded rows.
 */
export default function UpdatesList({
  filter,
  initialItems,
  initialCursor,
  totalUnread,
}: {
  filter: UpdatesFilter;
  initialItems: UpdateItem[];
  initialCursor: UpdatesCursor | null;
  totalUnread: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const tab = filter;
  const [items, setItems] = useState<UpdateItem[]>(initialItems);
  const [cursor, setCursor] = useState<UpdatesCursor | null>(initialCursor);
  const [readMap, setReadMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialItems.map((i) => [i.message_id, i.read]))
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();
  const [switching, startSwitch] = useTransition();

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

  const loadMore = () => {
    if (!cursor) return;
    startLoadMore(async () => {
      const res = await loadUpdatesPageAction({ filter, cursor });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.message_id));
        return [...prev, ...res.items.filter((i) => !seen.has(i.message_id))];
      });
      setReadMap((prev) => {
        const next = { ...prev };
        for (const i of res.items) if (!(i.message_id in next)) next[i.message_id] = i.read;
        return next;
      });
      setCursor(res.nextCursor);
    });
  };

  const selectTab = (key: UpdatesFilter) => {
    if (key === tab) return;
    startSwitch(() => {
      router.replace(key === "all" ? pathname : `${pathname}?filter=${key}`, {
        scroll: false,
      });
    });
  };

  const visible = useMemo(() => {
    if (tab === "all") return items;
    if (tab === "unread") return items.filter((i) => !(readMap[i.message_id] ?? true));
    return items.filter((i) => readMap[i.message_id] ?? true);
  }, [items, tab, readMap]);

  const unreadCount = totalUnread;

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
                const res = await markAllUpdatesReadAction();
                if (res.ok) {
                  setReadMap(Object.fromEntries(items.map((i) => [i.message_id, true])));
                  // nothing unread is left to page through
                  if (tab === "unread") setCursor(null);
                  setError(null);
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
            disabled={switching}
            onClick={() => selectTab(t.key)}
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

      {visible.length === 0 && !cursor ? (
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

      {cursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="self-center rounded-full border border-line bg-surface px-5 py-2 text-sm font-bold text-muted hover:bg-bg disabled:opacity-60"
        >
          {loadingMore ? "טוען…" : "טען עוד"}
        </button>
      )}
    </div>
  );
}
