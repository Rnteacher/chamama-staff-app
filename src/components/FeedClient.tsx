"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  markMessagesReadAction,
  markMessagesUnreadAction,
  moderateMessageAction,
  editMessageAction,
} from "@/lib/actions/messages";
import { formatDateTime } from "@/lib/format";

export interface FeedMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  createdAtLabel: string;
  updatedAtLabel: string | null;
  isGeneralVisible: boolean;
  isHiddenFromLeads: boolean;
  read: boolean;
  mine: boolean;
}

export default function FeedClient({
  studentId,
  messages,
  canModerate,
  showVisibilityStatus,
  focusMessageId,
  hasMore,
  page,
}: {
  studentId: string;
  messages: FeedMessage[];
  canModerate: boolean;
  showVisibilityStatus: boolean;
  focusMessageId?: string;
  hasMore: boolean;
  page: number;
}) {
  const router = useRouter();
  const [readMap, setReadMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(messages.map((m) => [m.id, m.read]))
  );
  const [flagOverrides, setFlagOverrides] = useState<
    Record<string, { isGeneralVisible: boolean; isHiddenFromLeads: boolean }>
  >({});
  const autoMarkedRef = useRef(false);
  const focusRef = useRef<HTMLLIElement | null>(null);
  const [pending, startTransition] = useTransition();

  // Opening the student page marks the currently visible messages as read.
  useEffect(() => {
    if (autoMarkedRef.current) return;
    autoMarkedRef.current = true;
    const unreadIds = messages.filter((m) => !m.read).map((m) => m.id);
    if (unreadIds.length === 0) return;
    const t = setTimeout(() => {
      setReadMap((prev) => {
        const next = { ...prev };
        for (const id of unreadIds) next[id] = true;
        return next;
      });
      startTransition(async () => {
        await markMessagesReadAction({ messageIds: unreadIds });
      });
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime: new messages on this student appear without manual refresh.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { createBrowserClient } = await import("@/lib/supabase/browser");
      const supabase = createBrowserClient();
      if (cancelled) return;
      const channel = supabase
        .channel(`student-feed-${studentId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "student_messages",
            filter: `student_id=eq.${studentId}`,
          },
          () => router.refresh()
        )
        .subscribe();
      unsubscribe = () => {
        void supabase.removeChannel(channel);
      };
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [studentId, router]);

  // Deep link (?m=…) — scroll to and highlight the referenced message.
  useEffect(() => {
    if (focusMessageId && focusRef.current) {
      focusRef.current.scrollIntoView({ block: "center" });
    }
  }, [focusMessageId]);

  function setRead(id: string, value: boolean) {
    setReadMap((prev) => ({ ...prev, [id]: value }));
    startTransition(async () => {
      const res = value
        ? await markMessagesReadAction({ messageIds: [id] })
        : await markMessagesUnreadAction({ messageIds: [id] });
      if (!res.ok) {
        setReadMap((prev) => ({ ...prev, [id]: !value }));
      }
    });
  }

  function setFlags(
    id: string,
    next: { isGeneralVisible: boolean; isHiddenFromLeads: boolean }
  ) {
    const prev = flagOverrides[id] ?? {
      isGeneralVisible:
        messages.find((m) => m.id === id)?.isGeneralVisible ?? false,
      isHiddenFromLeads:
        messages.find((m) => m.id === id)?.isHiddenFromLeads ?? false,
    };
    setFlagOverrides((p) => ({ ...p, [id]: next }));
    startTransition(async () => {
      const res = await moderateMessageAction({ messageId: id, ...next });
      if (!res.ok) {
        setFlagOverrides((p) => ({ ...p, [id]: prev }));
      }
    });
  }

  return (
    <section
      aria-label="עדכונים על החניך"
      aria-busy={pending}
      className="flex flex-col gap-3"
    >
      {hasMore && (
        <Link
          href={`/students/${studentId}?page=${page + 1}`}
          className="self-center rounded-full border border-line bg-surface px-5 py-2 text-sm font-bold hover:bg-brand-soft/40"
        >
          טענת עדכונים ישנים יותר
        </Link>
      )}

      <ul className="flex flex-col gap-3">
        {messages.map((m) => {
          const flags = flagOverrides[m.id] ?? {
            isGeneralVisible: m.isGeneralVisible,
            isHiddenFromLeads: m.isHiddenFromLeads,
          };
          const isRead = readMap[m.id] ?? true;
          const isFocus = focusMessageId === m.id;
          return (
            <li
              key={m.id}
              ref={isFocus ? focusRef : undefined}
              className={`rounded-2xl border bg-surface p-4 ${
                isFocus ? "border-brand-dark ring-2 ring-brand" : "border-line"
              } ${isRead ? "" : "border-r-4 border-r-brand-dark"}`}
              data-message-id={m.id}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-bold">{m.authorName}</span>
                <time
                  dateTime={m.createdAt}
                  title={formatDateTime(m.createdAt)}
                  className="shrink-0 text-xs text-muted"
                >
                  {m.createdAtLabel}
                  {m.updatedAtLabel && (
                    <span className="text-muted"> (נערך)</span>
                  )}
                </time>
              </div>

              <MessageBody initialBody={m.body} mine={m.mine} messageId={m.id} />

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {!isRead && (
                  <span className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-extrabold text-ink">
                    חדש
                  </span>
                )}
                {showVisibilityStatus && flags.isGeneralVisible && (
                  <span className="rounded-full border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold text-muted">
                    זמין לכל הצוות
                  </span>
                )}
                {showVisibilityStatus && flags.isHiddenFromLeads && (
                  <span className="rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-warn">
                    מוסתר ממאסטרים וראשי מגמה
                  </span>
                )}

                <span className="flex-1" />

                <button
                  type="button"
                  onClick={() => setRead(m.id, !isRead)}
                  className="rounded-full px-2.5 py-1 text-xs font-semibold text-muted hover:bg-bg"
                >
                  {isRead ? "סמן כלא נקרא" : "סמן כנקרא"}
                </button>
              </div>

              {canModerate && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                  <ModChip
                    active={flags.isGeneralVisible}
                    onClick={() =>
                      setFlags(m.id, { ...flags, isGeneralVisible: !flags.isGeneralVisible })
                    }
                    activeLabel="מוצג לכל הצוות"
                    inactiveLabel="אישור תצוגה לכל הצוות"
                  />
                  <ModChip
                    active={flags.isHiddenFromLeads}
                    danger
                    onClick={() =>
                      setFlags(m.id, { ...flags, isHiddenFromLeads: !flags.isHiddenFromLeads })
                    }
                    activeLabel="מוסתר ממאסטרים וראשי מגמה"
                    inactiveLabel="הסתרה ממאסטרים וראשי מגמה"
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MessageBody({
  initialBody,
  mine,
  messageId,
}: {
  initialBody: string;
  mine: boolean;
  messageId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (editing) {
    return (
      <div className="mt-2">
        <label htmlFor={`edit-${messageId}`} className="sr-only">
          עריכת ההודעה
        </label>
        <textarea
          id={`edit-${messageId}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          className="w-full rounded-xl border border-line px-3 py-2.5"
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await editMessageAction({
                  messageId,
                  body: value,
                });
                if (res.ok) {
                  setEditing(false);
                  router.refresh();
                } else {
                  setError(res.error);
                }
              })
            }
            className="rounded-full bg-brand px-4 py-1.5 text-sm font-bold text-ink disabled:opacity-60"
          >
            {pending ? "שומר…" : "שמירה"}
          </button>
          <button
            type="button"
            onClick={() => {
              setValue(initialBody);
              setEditing(false);
            }}
            className="rounded-full border border-line px-4 py-1.5 text-sm font-semibold"
          >
            ביטול
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-7 text-ink/95">
        {initialBody}
      </p>
      {mine && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-1 rounded-full px-2 py-1 text-xs font-semibold text-muted hover:bg-bg"
        >
          עריכה
        </button>
      )}
    </div>
  );
}

function ModChip({
  active,
  danger,
  onClick,
  activeLabel,
  inactiveLabel,
}: {
  active: boolean;
  danger?: boolean;
  onClick: () => void;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
        active
          ? danger
            ? "border-warn bg-amber-100 text-warn"
            : "border-brand-dark bg-brand-soft text-ink"
          : "border-line bg-surface text-muted hover:bg-bg"
      }`}
    >
      {active ? activeLabel : inactiveLabel}
    </button>
  );
}
