"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitAdhocMeetingReportAction, updateMeetingReportAction } from "@/lib/actions/meetings";
import { deleteMeetingReportAction } from "@/lib/actions/meetings-delete";
import { jerusalemWallTimeToUtc, jerusalemParts } from "@/lib/meetings";
import ConversationalForm, { type Question, type Answers } from "@/components/conversational/ConversationalForm";

export interface ReportDetail {
  id: string;
  meeting_at: string;
  created_at: string;
  staff_name: string;
  context: "mentor" | "master";
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

export function ReportCard({ r, onDelete }: { r: ReportDetail; onDelete?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const dt = new Date(r.meeting_at);
  const dateStr = dt.toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "numeric" });
  const timeStr = dt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold text-muted">דיווח פגישת {CTX[r.context]}</p>
          <p className="font-bold">{dateStr} · {timeStr}</p>
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
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-sm">
          {r.intervention_functional && <p><span className="font-bold">תפקודי:</span> {r.intervention_functional}</p>}
          {r.intervention_emotional && <p><span className="font-bold">רגשי:</span> {r.intervention_emotional}</p>}
          {r.intervention_other && <p><span className="font-bold">אחר:</span> {r.intervention_other}</p>}
          {r.next_steps && <p><span className="font-bold">לקראת הבאה:</span> {r.next_steps}</p>}
          <p className="text-xs text-muted">דווח: {new Date(r.created_at).toLocaleString("he-IL")}</p>
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted">
          {expanded ? "פחות" : "פרטים"}
        </button>
        {onDelete && (
          <button type="button" onClick={onDelete}
            className="rounded-full border border-line px-3 py-1 text-xs font-bold text-danger">
            מחק דוח
          </button>
        )}
      </div>
    </div>
  );
}

export function MeetingReportEditor({ studentId, report, onClose }: {
  studentId: string;
  report: {
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
  };
  onClose: () => void;
}) {
  const dt = new Date(report.meeting_at);
  const p = jerusalemParts(dt);
  const defaultDt = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;

  const [meetingAtLocal, setMeetingAtLocal] = useState(defaultDt);
  const [held, setHeld] = useState(report.held);
  const [notHeldReason, setNotHeldReason] = useState(report.not_held_reason ?? "");
  const [status, setStatus] = useState(report.status);
  const [intervention, setIntervention] = useState(report.intervention);
  const [categories, setCategories] = useState<string[]>(report.intervention_categories);
  const [detailFunctional, setDetailFunctional] = useState(report.intervention_functional ?? "");
  const [detailEmotional, setDetailEmotional] = useState(report.intervention_emotional ?? "");
  const [detailOther, setDetailOther] = useState(report.intervention_other ?? "");
  const [nextSteps, setNextSteps] = useState(report.next_steps ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await updateMeetingReportAction({
        reportId: report.id,
        meetingAtLocal: defaultDt,
        held,
        notHeldReason,
        status: status as "green" | "yellow" | "red",
        intervention,
        categories: categories as ("functional" | "emotional" | "other")[],
        detailFunctional,
        detailEmotional,
        detailOther,
        nextSteps,
      });
      if (res.ok) { onClose(); router.refresh(); }
      else setError(res.error);
    });
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/55 p-4" role="dialog" aria-modal="true">
      <div className="mx-auto mt-6 w-full max-w-md rounded-3xl border border-line bg-surface p-5 pb-10">
        <h3 className="text-lg font-extrabold">עריכת דוח פגישה</h3>
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <label>מועד הפגישה
            <input type="datetime-local" value={defaultDt}
              onChange={(e) => setMeetingAtLocal(e.target.value)}
              className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={held} onChange={(e) => setHeld(e.target.checked)} className="h-5 w-5 accent-[#46b800]" />
            הפגישה התקיימה
          </label>
          {!held && (
            <label>סיבה
              <textarea value={notHeldReason} onChange={(e) => setNotHeldReason(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2" rows={2} />
            </label>
          )}
          <label>מצב החניך/ה
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2">
              <option value="green">ירוק</option><option value="yellow">צהוב</option><option value="red">אדום</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={intervention} onChange={(e) => setIntervention(e.target.checked)} className="h-5 w-5 accent-[#46b800]" />
            נדרשת התערבות
          </label>
          {intervention && (
            <>
              {(["functional", "emotional", "other"] as const).map((cat) => (
                <label key={cat} className="flex items-center gap-2">
                  <input type="checkbox" checked={categories.includes(cat)}
                    onChange={(e) => setCategories((p) => e.target.checked ? [...p, cat] : p.filter((c) => c !== cat))}
                    className="h-5 w-5 accent-[#46b800]" />
                  {CAT[cat]}
                </label>
              ))}
              {categories.includes("functional") && (
                <label>פירוט תפקודי<input value={detailFunctional} onChange={(e) => setDetailFunctional(e.target.value)} className="mt-1 w-full rounded-xl border border-line px-3 py-2" /></label>
              )}
              {categories.includes("emotional") && (
                <label>פירוט רגשי<input value={detailEmotional} onChange={(e) => setDetailEmotional(e.target.value)} className="mt-1 w-full rounded-xl border border-line px-3 py-2" /></label>
              )}
              {categories.includes("other") && (
                <label>פירוט אחר<input value={detailOther} onChange={(e) => setDetailOther(e.target.value)} className="mt-1 w-full rounded-xl border border-line px-3 py-2" /></label>
              )}
            </>
          )}
          <label>מה הוחלט לקראת הפגישה הבאה
            <textarea value={nextSteps} onChange={(e) => setNextSteps(e.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
        </div>
        {error && <p role="alert" className="mt-2 text-sm font-bold text-danger">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={save} disabled={pending}
            className="flex-1 rounded-full bg-brand px-4 py-3 font-extrabold text-ink disabled:opacity-60">
            {pending ? "שומר…" : "שמירה"}
          </button>
          <button type="button" onClick={onClose} className="rounded-full border border-line px-5 py-3 font-bold">ביטול</button>
        </div>
      </div>
    </div>
  );
}

export { jerusalemWallTimeToUtc, jerusalemParts };
