import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/lib/validation";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type EmploymentOverviewData } from "@/lib/employment";
import { getViewAsState } from "@/lib/view-as";
import PlacementEditor from "@/components/employment/PlacementEditor";
import WorkLogsPanel, { type WorkLogRow } from "@/components/employment/WorkLogsPanel";
import ExceptionsPanel, { type ExceptionRow } from "@/components/employment/ExceptionsPanel";
import { computeEmploymentProgress } from "@/lib/employment";

export const metadata = { title: "ניהול תעסוקה · חניך" };

export default async function EmploymentDetailPage({
  params,
}: PageProps<"/admin/employment/[studentId]">) {
  const me = await requireMe();
  const viewAs = await getViewAsState();
  const allowed =
    hasRole(me, "employment_coordinator") ||
    hasRole(me, "leadership") ||
    hasRole(me, "super_admin");
  if (!allowed) redirect("/?error=אין%20הרשאה%20לניהול%20תעסוקה");
  // View-As: read-only — no mutation controls at all
  const canManage = allowed && !viewAs.active;

  const { studentId } = await params;
  if (!isUuid(studentId)) notFound();

  const supabase = await createClient();
  const [studentRes, overviewRes] = await Promise.all([
    supabase
      .from("students")
      .select("id, first_name, last_name, greenhouse_groups(name)")
      .eq("id", studentId)
      .maybeSingle(),
    supabase.rpc("student_employment_overview", { p_student_id: studentId }),
  ]);

  const student = studentRes.data as unknown as {
    id: string;
    first_name: string;
    last_name: string;
    greenhouse_groups: { name: string } | null;
  } | null;
  if (!student) notFound();

  const overview = (overviewRes.data ?? {}) as unknown as EmploymentOverviewData;
  const progress = computeEmploymentProgress(overview.total_minutes ?? 0);

  const logs: WorkLogRow[] = (overview.recent_logs ?? []).map((l) => ({
    id: l.id,
    work_date: l.work_date,
    start_time: l.start_time,
    end_time: l.end_time,
    duration_minutes: l.duration_minutes,
    note: l.note,
  }));
  const exceptions: ExceptionRow[] = (overview.exceptions ?? []).map((e) => ({
    id: e.id,
    work_date: e.work_date,
    kind: e.kind,
    start_time: e.start_time,
    end_time: e.end_time,
  }));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-extrabold">
            {student.first_name} {student.last_name}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {student.greenhouse_groups?.name ?? "—"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-extrabold" dir="ltr">{progress.label}</span>
          <Link href="/admin/employment" className="text-sm font-medium text-muted hover:text-ink">
            ‹ לכל החניכים
          </Link>
        </div>
      </header>

      <PlacementEditor
        data={{
          studentId: student.id,
          studentName: `${student.first_name} ${student.last_name}`,
          placement: overview.placement,
          weeklySlots: overview.weekly_slots ?? [],
          eligible: overview.eligible,
          cohortNote: overview.cohort_note ?? null,
        }}
        readOnly={!canManage}
      />

      {overview.placement && (
        <>
          <ExceptionsPanel
            placementId={overview.placement.id}
            studentId={student.id}
            exceptions={exceptions}
            canManage={canManage}
          />
          <WorkLogsPanel
            placementId={overview.placement.id}
            studentId={student.id}
            logs={logs}
            canManage={canManage}
          />
        </>
      )}
    </div>
  );
}
