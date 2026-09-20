"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  markMessagesReadAction,
  markMessagesUnreadAction,
  deleteMessageAction,
  editMessageAction,
} from "@/lib/actions/messages";
import { deleteMeetingReportAction } from "@/lib/actions/meetings-delete";
import { updateMeetingReportAction } from "@/lib/actions/meetings";
import { MeetingReportEditor } from "@/components/meetings/MeetingReportDetail";

export interface FeedItem {
  item_id: string;
  kind: "message" | "report" | "form";
  category: "ongoing" | "project";
  at: string;
  actor_name: string;
  title: string | null;
  body: string | null;
  held: boolean | null;
  status: string | null;
  intervention: boolean | null;
  read: boolean;
  not_held_reason: string | null;
  intervention_categories: string[] | null;
  intervention_functional: string | null;
  intervention_emotional: string | null;
  intervention_other: string | null;
  next_steps: string | null;
  meeting_at: string | null;
  source_id: string | null;
  author_staff_id: string | null;
}

type FilterTab = "all" | "ongoing" | "project";
const CTX_TOGGLE: Record<string, string> = { mentor: "פגישות מנטור", master: "פגישות מאסטר" };
const CTX: Record<string, string> = { mentor: "מנטור", master: "מאסטר" };
const ST: Record<string, string> = { green: "ירוק", yellow: "צהוב", red: "אדום" };
const ST_CLS: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800 border-emerald-300",
  yellow: "bg-amber-100 text-amber-800 border-amber-300",
  red: "bg-red-100 text-red-800 border-red-300",
};
const CAT: Record<string, string> = { functional: "תפקודי", emotional: "רגשי", other: "אחר" };

export default function UnifiedUpdatesFeed({
  items,
  canModerate,
  showVisibilityStatus,
  focusMessageId,
  studentId,
  canEditReports,
  currentStaffId,
  isSuperAdmin = false,
  readOnly = false,
}: {
  items: FeedItem[];
  canModerate: boolean;
  showVisibilityStatus: boolean;
  focusMessageId?: string;
  studentId: string;
  canEditReports: boolean;
  /** server-derived current staff identity — gates message edit/delete */
  currentStaffId: string | null;
  isSuperAdmin?: boolean;
  /** View-As: hide every mutation control */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<FilterTab>("all");
  const [showMentor, setShowMentor] = useState(true);
  const [showMaster, setShowMaster] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(
    focusMessageId ?? null
  );
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [deletingReportId, setDeletingReportId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    return items.filter((i) => {
      // meeting report context filtering (additive toggles, not exclusive tabs)
      if (i.kind === "report") {
        const isMentorReport = i.title?.includes("מנטור") ?? false;
        if (isMentorReport && !showMentor) return false;
        if (!isMentorReport && !showMaster) return false;
      }
      return true;
    });
  }, [items, showMentor, showMaster]);

  function markRead(id: string, isRead: boolean) {
    startTransition(async () => {
      if (isRead) {
        await markMessagesReadAction({ messageIds: [id] });
      } else {
        await markMessagesUnreadAction({ messageIds: [id] });
      }
      router.refresh();
    });
  }

  function handleDeleteMessage(id: string) {
    startTransition(async () => {
      const res = await deleteMessageAction(id);
      if (res.ok) router.refresh();
    });
  }

  function handleDeleteReport(id: string) {
    if (deletingReportId !== id) { setDeletingReportId(id); return; }
    startTransition(async () => {
      await deleteMeetingReportAction(id);
      setDeletingReportId(null);
      router.refresh();
    });
  }

  return (
    <section aria-label="עדכונים" className="flex flex-col gap-3">
      {/* meeting type toggle filters (additive, both on by default) */}
      <div className="flex gap-2" role="group" aria-label="סינון סוגי פגישות">
        {Object.entries(CTX_TOGGLE).map(([key, label]) => {
          const isOn = key === "mentor" ? showMentor : showMaster;
          return (
            <button key={key} type="button" aria-pressed={isOn}
              onClick={() => key === "mentor" ? setShowMentor((v) => !v) : setShowMaster((v) => !v)}
              className={`rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors ${
                isOn ? "border-brand-dark bg-brand-soft text-ink" : "border-line bg-surface text-muted opacity-60"
              }`}>
              {isOn ? "✓ " : ""}{label}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">??? ??????? ???????? ??.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((item) => {
            const isExpanded = expandedId === item.item_id;
            const isFocus = focusMessageId === item.item_id;
            const isMessage = item.kind === "message";
            const isReport = item.kind === "report";

            return (
              <li key={`${item.kind}-${item.item_id}`}
                className={`rounded-2xl border bg-surface p-4 ${
                  isFocus ? "border-brand-dark ring-2 ring-brand" : isMessage && !item.read ? "border-r-4 border-r-brand-dark" : "border-line"
                }`}>
                {/* header */}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-bold">
                    {isReport && (
                      <span className="mr-1.5 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-extrabold text-ink">
                        {item.title}
                      </span>
                    )}
                    {item.actor_name}
                  </span>
                  <time dateTime={item.at} className="shrink-0 text-xs text-muted">
                    {new Date(item.at).toLocaleString("he-IL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </time>
                </div>

                {/* message body */}
                {isMessage && (
                  <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-7 text-ink/95">{item.body}</p>
                )}

                {/* report summary */}
                {isReport && (
                  <div className="mt-1.5 space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      {item.held !== null && !item.held && (
                        <span className="text-warn font-semibold">לא התקיימה</span>
                      )}
                      {item.status && (
                        <span className={`rounded-full border px-2 py-0.5 text-xs font-extrabold ${ST_CLS[item.status] ?? ""}`}>
                          {ST[item.status]}
                        </span>
                      )}
                      {item.intervention && (
                        <span className="rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-xs font-bold text-warn">נדרשת התערבות</span>
                      )}
                    </div>
                    {item.body && <p className="text-muted">{item.body}</p>}
                  </div>
                )}

                {/* form submission summary */}
                {item.kind === "form" && (
                  <p className="mt-1 text-sm text-muted">{item.title}</p>
                )}

                {/* message visibility badges are not available from student_feed_items;
                    they remain accessible in the DB and can be added when the RPC
                    is extended to return them */}

                {/* actions */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {isMessage && (
                    <>
                      <button type="button" onClick={() => markRead(item.item_id, !item.read)}
                        className="rounded-full px-2.5 py-1 text-xs font-semibold text-muted hover:bg-bg">
                        {item.read ? "סמן כלא נקרא" : "סמן כנקרא"}
                      </button>
                      {!readOnly && (item.author_staff_id === currentStaffId || isSuperAdmin) && (
                        <MessageEditDelete
                          messageId={item.source_id ?? item.item_id}
                          currentBody={item.body ?? ""}
                          canEdit={item.author_staff_id === currentStaffId}
                          onDelete={() => handleDeleteMessage(item.source_id ?? item.item_id)}
                        />
                      )}
                    </>
                  )}
                  {isReport && (
                    <>
                      <button type="button"
                        onClick={() => setExpandedId(isExpanded ? null : item.item_id)}
                        className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted">
                        {isExpanded ? "פחות" : "פרטים"}
                      </button>
                      {canEditReports && (
                        <>
                          <button type="button" onClick={() => setEditingReportId(item.item_id)}
                            className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted">עריכה</button>
                          <button type="button" onClick={() => handleDeleteReport(item.item_id)}
                            disabled={pending}
                            className="rounded-full border border-line px-3 py-1 text-xs font-bold text-danger disabled:opacity-60">
                            מחק דוח
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>

                {/* report expanded detail */}
                {isReport && isExpanded && (
                  <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
                    {!item.held && item.not_held_reason && (
                      <p><span className="font-bold">סיבה:</span> {item.not_held_reason}</p>
                    )}
                    {item.intervention_categories && item.intervention_categories.length > 0 && (
                      <p><span className="font-bold">תחומים:</span> {item.intervention_categories.map((c) => CAT[c] ?? c).join(", ")}</p>
                    )}
                    {item.intervention_functional && <p><span className="font-bold">תפקודי:</span> {item.intervention_functional}</p>}
                    {item.intervention_emotional && <p><span className="font-bold">רגשי:</span> {item.intervention_emotional}</p>}
                    {item.intervention_other && <p><span className="font-bold">אחר:</span> {item.intervention_other}</p>}
                    {item.next_steps && <p><span className="font-bold">לקראת הבאה:</span> {item.next_steps}</p>}
                  </div>
                )}

                {/* delete confirmation */}
                {isReport && deletingReportId === item.item_id && (
                  <div className="mt-2 flex items-center gap-2 rounded-xl bg-red-50 p-2 text-xs">
                    <span className="font-bold text-danger">למחוק דוח זה?</span>
                    <button type="button" onClick={() => handleDeleteReport(item.item_id)} disabled={pending}
                      className="rounded-full bg-danger px-3 py-1 text-xs font-bold text-white">אישור</button>
                    <button type="button" onClick={() => setDeletingReportId(null)}
                      className="rounded-full border border-line px-3 py-1 text-xs font-bold">ביטול</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* report edit modal */}
      {editingReportId && (() => {
        const report = items.find((i) => i.item_id === editingReportId);
        if (!report) return null;
        return (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/55 p-4" role="dialog" aria-modal="true">
            <div className="mx-auto mt-6 w-full max-w-md rounded-3xl border border-line bg-surface p-5 pb-10">
              <h3 className="text-lg font-extrabold">עריכת דוח פגישה</h3>
              <div className="mt-3 flex flex-col gap-3 text-sm">
                <label>מועד הפגישה
                  <input type="datetime-local"
                    value={report.meeting_at ? new Date(report.meeting_at).toISOString().slice(0, 16) : ""}
                    onChange={(e) => {
                      // handled in the save call below
                    }}
                    disabled
                    className="mt-1 w-full rounded-xl border border-line px-3 py-2 opacity-60" />
                  <span className="mt-1 block text-xs text-muted">מועד הפגישה נקבע בעת היצירה ואינו ניתן לשינוי בעריכה מהירה</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={report.held ?? false} onChange={() => {}} disabled className="h-5 w-5 opacity-60" />
                  הפגישה התקיימה ({report.held ? "כן" : "לא"})
                </label>
                <p className="text-xs text-muted">
                  עריכת מלוא פרטי הדוח תתאפשר בגרסה הבאה. כרגע ניתן למחוק וליצור דוח חדש.
                </p>
              </div>
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => { setEditingReportId(null); router.refresh(); }}
                  className="flex-1 rounded-full bg-ink px-4 py-3 font-extrabold text-white">סגירה</button>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}

function MessageEditDelete({ messageId, currentBody, canEdit, onDelete }: {
  messageId: string;
  currentBody: string;
  canEdit: boolean;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(currentBody);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (editing) {
    return (
      <div className="mt-2 flex flex-col gap-2">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="w-full rounded-xl border border-line px-3 py-2 text-sm" />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-1.5">
          <button type="button" disabled={pending} onClick={() => startTransition(async () => {
            const res = await editMessageAction({ messageId, body });
            if (res.ok) { setEditing(false); router.refresh(); } else setError(res.error);
          })} className="rounded-full bg-brand px-3 py-1 text-xs font-bold text-ink">שמירה</button>
          <button type="button" onClick={() => setEditing(false)} className="rounded-full border border-line px-3 py-1 text-xs">ביטול</button>
        </div>
      </div>
    );
  }
  return (
    <>
      {canEdit && (
        <button type="button" onClick={() => setEditing(true)} className="rounded-full px-2.5 py-1 text-xs font-semibold text-muted hover:bg-bg">עריכה</button>
      )}
      <button type="button" onClick={() => { if (confirm("למחוק עדכון זה? הדיווחים ושאר העדכונים לא יושפעו.")) { startTransition(async () => {
        const res = await deleteMessageAction(messageId);
        if (res.ok) router.refresh(); else setError(res.error ?? "נכשל");
      }); } }} className="rounded-full px-2.5 py-1 text-xs font-semibold text-danger hover:bg-red-50">מחיקה</button>
    </>
  );
}
