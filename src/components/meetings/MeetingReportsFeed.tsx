"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteMeetingReportAction } from "@/lib/actions/meetings-delete";
import { MeetingReportEditor } from "@/components/meetings/MeetingReportDetail";

export interface MeetingReportItem {
  id: string;
  meeting_at: string;
  created_at: string;
  staff_name: string;
  context: string;
  held: boolean;
  not_held_reason: string | null;
  status: string;
  intervention: boolean;
  intervention_categories: string[];
  intervention_functional: string | null;
  intervention_emotional: string | null;
  intervention_other: string | null;
  next_steps: string | null;
  is_mine: boolean;
}

const CTX: Record<string, string> = { mentor: "מנטור", master: "מאסטר" };
const ST: Record<string, string> = { green: "ירוק", yellow: "צהוב", red: "אדום" };
const ST_CLS: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800 border-emerald-300",
  yellow: "bg-amber-100 text-amber-800 border-amber-300",
  red: "bg-red-100 text-red-800 border-red-300",
};
const CAT: Record<string, string> = { functional: "תפקודי", emotional: "רגשי", other: "אחר" };

export default function MeetingReportsFeed({
  studentId,
  reports,
  canEdit,
}: {
  studentId: string;
  reports: MeetingReportItem[];
  canEdit: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (reports.length === 0) return null;

  function handleDelete(id: string) {
    if (deletingId !== id) { setDeletingId(id); return; }
    startTransition(async () => {
      await deleteMeetingReportAction(id);
      setDeletingId(null);
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="reports-feed-heading" className="flex flex-col gap-2">
      <h3 id="reports-feed-heading" className="text-sm font-bold text-muted">דיווחי פגישות</h3>
      {reports.map((r) => {
        const dt = new Date(r.meeting_at);
        const isExpanded = expandedId === r.id;
        return (
          <div key={r.id} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-bold text-muted">דיווח פגישת {CTX[r.context]}</p>
                <p className="font-bold">
                  {dt.toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "numeric" })}
                  {" · "}
                  {dt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                </p>
                <p className="text-xs text-muted">דיווח: {r.staff_name}</p>
              </div>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-extrabold ${ST_CLS[r.status] ?? ""}`}>
                {ST[r.status] ?? r.status}
              </span>
            </div>
            {!r.held && r.not_held_reason && (
              <p className="mt-1.5 text-sm text-warn">לא התקיימה: {r.not_held_reason}</p>
            )}
            {r.intervention && (
              <p className="mt-1 text-xs font-bold text-warn">
                נדרשת התערבות{r.intervention_categories.length > 0 && `: ${r.intervention_categories.map((c) => CAT[c] ?? c).join(", ")}`}
              </p>
            )}
            {isExpanded && (
              <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-sm">
                {r.intervention_functional && <p><span className="font-bold">תפקודי:</span> {r.intervention_functional}</p>}
                {r.intervention_emotional && <p><span className="font-bold">רגשי:</span> {r.intervention_emotional}</p>}
                {r.intervention_other && <p><span className="font-bold">אחר:</span> {r.intervention_other}</p>}
                {r.next_steps && <p><span className="font-bold">לקראת הבאה:</span> {r.next_steps}</p>}
                <p className="text-xs text-muted">דווח: {new Date(r.created_at).toLocaleString("he-IL")}</p>
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => setExpandedId(isExpanded ? null : r.id)}
                className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted">
                {isExpanded ? "פחות" : "פרטים"}
              </button>
              {r.is_mine && (
                <button type="button" onClick={() => setEditingId(r.id)}
                  className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted">
                  עריכה
                </button>
              )}
              {(r.is_mine || canEdit) && !deletingId && (
                <button type="button" onClick={() => handleDelete(r.id)}
                  disabled={pending}
                  className="rounded-full border border-line px-3 py-1 text-xs font-bold text-danger disabled:opacity-60">
                  {deletingId === r.id ? "…" : "מחק דוח"}
                </button>
              )}
            </div>
            {deletingId === r.id && (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-red-50 p-2 text-xs">
                <span className="font-bold text-danger">למחוק דוח זה?</span>
                <button type="button" onClick={() => handleDelete(r.id)} disabled={pending}
                  className="rounded-full bg-danger px-3 py-1 text-xs font-bold text-white">אישור</button>
                <button type="button" onClick={() => setDeletingId(null)}
                  className="rounded-full border border-line px-3 py-1 text-xs font-bold">ביטול</button>
              </div>
            )}
          </div>
        );
      })}
      {editingId && (() => {
        const report = reports.find((r) => r.id === editingId);
        if (!report) return null;
        return (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/55 p-4" role="dialog" aria-modal="true">
            <div className="mx-auto mt-6 w-full max-w-md rounded-3xl border border-line bg-surface p-5 pb-10">
              <h3 className="text-lg font-extrabold">עריכת דוח פגישה</h3>
              <MeetingReportEditor studentId={studentId} report={{
                ...report,
                not_held_reason: report.not_held_reason,
              }} onClose={() => { setEditingId(null); router.refresh(); }} />
            </div>
          </div>
        );
      })()}
    </section>
  );
}
