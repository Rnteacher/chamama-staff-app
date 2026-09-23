import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe, isPrivileged } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { WEEKDAY_SHORT_LABELS } from "@/lib/meetings";
import StudentMeetingsPanel, {
  type ScheduleRow,
  type ReportableOccurrence,
} from "@/components/meetings/StudentMeetingsPanel";
import UnifiedUpdatesFeed, { type FeedItem } from "@/components/feed/UnifiedUpdatesFeed";
import Composer from "@/components/Composer";
import MarkAllReadButton from "@/components/MarkStudentReadButton";
import EmptyState from "@/components/EmptyState";
import StudentEmploymentCard from "@/components/employment/StudentEmploymentCard";
import AddToEmploymentButton from "@/components/employment/AddToEmploymentButton";
import { employmentApplies, type EmploymentOverviewData } from "@/lib/employment";
import StudentDayPlanForm from "@/components/attendance/StudentDayPlanForm";
import { hasRole } from "@/lib/auth";
import { jerusalemParts } from "@/lib/meetings";
import { isoDate } from "@/lib/schedule";
import type { EffectiveSchoolStatus } from "@/lib/attendance";
import { getViewAsState } from "@/lib/view-as";
import { getUnreadCounts } from "@/lib/unread";

export const metadata = { title: "חניך" };

export default async function StudentPage({
  params,
  searchParams,
}: PageProps<"/students/[id]">) {
  const [{ id }, sp, supabase] = await Promise.all([params, searchParams, createClient()]);
  const focusMessageId = typeof sp.m === "string" ? sp.m : undefined;
  const jp = jerusalemParts(new Date());

  // Everything below is keyed by the student id from the URL (RLS-scoped,
  // read-only STABLE RPCs), so it all starts together with the shared
  // identity / View-As / unread lookups in ONE round trip. Nothing is
  // rendered before requireMe() has passed.
  const [
    me,
    viewAs,
    studentRes,
    mastersRes,
    feedRes,
    unreadByStudent,
    schedulesRes,
    reportableRes,
    employmentRes,
    effectiveRes,
  ] = await Promise.all([
    requireMe(),
    getViewAsState(),
    supabase
      .from("students")
      .select(
        "id, first_name, last_name, is_archived, group_id, major_id, greenhouse_groups(id, name, group_mentors(profiles(id, full_name))), majors(id, name)"
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("master_assignments").select("profiles(id, full_name)").eq("student_id", id),
    supabase.rpc("student_feed_items", { p_student_id: id }),
    getUnreadCounts(),
    supabase.from("meeting_schedules").select("id, staff_id, context, weekday, meeting_time, is_active, profiles(full_name)").eq("student_id", id).order("weekday"),
    supabase.rpc("my_reportable_occurrences", { p_student_id: id }),
    supabase.rpc("student_employment_overview", { p_student_id: id }),
    supabase.rpc("student_effective_school_status", {
      p_student_id: id,
      p_date: isoDate(jp.year, jp.month, jp.day),
    }),
  ]);

  const student = studentRes.data as unknown as
    | {
        id: string;
        first_name: string;
        last_name: string;
        is_archived: boolean;
        group_id: string | null;
        major_id: string | null;
        greenhouse_groups: {
          id: string;
          name: string;
          group_mentors: Array<{ profiles: { id: string; full_name: string | null } | null }> | null;
        } | null;
        majors: { id: string; name: string } | null;
      }
    | null;

  if (!student) notFound();

  const unreadCount = unreadByStudent.get(student.id) ?? 0;

  // the real user's canonical relationships (group_mentors /
  // master_assignments) arrive with the identity
  const isMyMentee = Boolean(student.group_id && me.mentorGroupIds.includes(student.group_id));
  const isMyMasterStudent = me.masterStudentIds.includes(student.id);
  const canModerate = isMyMentee;
  const privileged = isPrivileged(me);
  const isSuper = me.roles.includes("super_admin");

  const mentorNames = (student.greenhouse_groups?.group_mentors ?? [])
    .map((m) => m.profiles?.full_name)
    .filter((n): n is string => Boolean(n));

  const masterNames = (mastersRes.data ?? [])
    .map((m) => (m as unknown as { profiles: { full_name: string | null } | null }).profiles?.full_name)
    .filter((n): n is string => Boolean(n));

  const allowedContexts: ("mentor" | "master")[] = [
    ...(isMyMentee || isSuper ? (["mentor"] as const) : []),
    ...(isMyMasterStudent || isSuper ? (["master"] as const) : []),
  ];

  const schedules: ScheduleRow[] = (schedulesRes.data ?? []).map((s) => {
    const row = s as unknown as {
      id: string; staff_id: string; context: "mentor" | "master";
      weekday: number; meeting_time: string; is_active: boolean;
      profiles: { full_name: string | null } | null;
    };
    return {
      id: row.id, context: row.context, weekday: row.weekday,
      meetingTime: row.meeting_time.slice(0, 5), isActive: row.is_active,
      staffName: row.profiles?.full_name ?? "צוות", mine: row.staff_id === me.staffId,
    };
  });

  const reportable: ReportableOccurrence[] = (
    (reportableRes.data ?? []) as Array<{
      occurrence_id: string; due_at: string; context: "mentor" | "master";
    }>
  ).map((row) => ({ occurrenceId: row.occurrence_id, dueAt: row.due_at, context: row.context }));

  const meetingParam = typeof sp.meeting === "string" ? sp.meeting : undefined;
  const autoOpenReport = sp.report === "1";

  // unified feed items from student_feed_items RPC (messages + reports + forms)
  const feedItems: FeedItem[] = ((feedRes.data ?? []) as Array<{
    item_id: string; kind: string; category: string; at: string;
    actor_name: string; title: string; body: string;
    held: boolean | null; status: string | null; intervention: boolean | null;
    read: boolean; not_held_reason: string | null;
    intervention_categories: string[] | null; intervention_functional: string | null;
    intervention_emotional: string | null; intervention_other: string | null;
    next_steps: string | null; meeting_at: string | null; source_id: string | null;
    author_staff_id: string | null;
  }>).map((r) => ({
    item_id: r.item_id, kind: r.kind as FeedItem["kind"], category: r.category as FeedItem["category"],
    at: r.at, actor_name: r.actor_name, title: r.title, body: r.body,
    held: r.held, status: r.status, intervention: r.intervention, read: r.read,
    not_held_reason: r.not_held_reason, intervention_categories: r.intervention_categories,
    intervention_functional: r.intervention_functional, intervention_emotional: r.intervention_emotional,
    intervention_other: r.intervention_other, next_steps: r.next_steps,
    meeting_at: r.meeting_at, source_id: r.source_id,
    author_staff_id: r.author_staff_id ?? null,
  }));

  const employment = (employmentRes.data ?? null) as unknown as EmploymentOverviewData | null;
  // employment managers (never in View-As) may change the override
  const canManageEmployment =
    !viewAs.active &&
    (hasRole(me, "employment_coordinator") ||
      hasRole(me, "leadership") ||
      hasRole(me, "super_admin"));

  return (
    /* Desktop: main column (feed + composer) beside a secondary column
       (summary + recurring meetings). Mobile: original single-column flow. */
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] lg:items-start lg:gap-6">
      <header className="order-1 rounded-2xl border border-line bg-surface p-4 lg:col-start-2 lg:row-start-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-extrabold">{student.first_name} {student.last_name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted">
              {student.greenhouse_groups && (
                <Link href={`/groups/${student.greenhouse_groups.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                  {student.greenhouse_groups.name}
                </Link>
              )}
              {student.majors && (<><span aria-hidden="true">·</span>
                <Link href={`/majors/${student.majors.id}`} className="underline-offset-2 hover:underline">{student.majors.name}</Link>
              </>)}
            </p>
          </div>
          {student.is_archived && (
            <span className="shrink-0 rounded-full border border-warn px-2.5 py-1 text-xs font-bold text-warn">ארכיון</span>
          )}
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2 lg:grid-cols-1">
          <div className="flex gap-1"><dt className="font-bold">מנטורים:</dt><dd className="text-muted">{mentorNames.length > 0 ? mentorNames.join(", ") : "—"}</dd></div>
          <div className="flex gap-1"><dt className="font-bold">מאסטרים:</dt><dd className="text-muted">{masterNames.length > 0 ? masterNames.join(", ") : "—"}</dd></div>
        </dl>
        {unreadCount > 0 && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-brand-soft px-3 py-2">
            <span className="text-sm font-bold">{unreadCount} עדכונים שלא נקראו</span>
            <MarkAllReadButton studentId={student.id} label="סמן הכל כנקרא" />
          </div>
        )}
        {/* employment does not apply yet (no section is shown): managers can
            add the student — sets the existing force-eligible override */}
        {canManageEmployment && employment && !employmentApplies(employment) && (
          <AddToEmploymentButton studentId={student.id} />
        )}
      </header>

      <div className="order-2 min-w-0 lg:col-start-2 lg:row-start-2 flex flex-col gap-4">
        {/* planned arrival/departure + today's effective status (secondary to
            actual attendance; plan writes: home-group mentor|leadership|admin) */}
        <StudentDayPlanForm
          studentId={student.id}
          date={isoDate(jp.year, jp.month, jp.day)}
          studentName={`${student.first_name} ${student.last_name}`}
          effective={
            (effectiveRes.data ?? {}) as unknown as EffectiveSchoolStatus
          }
          canManage={
            !viewAs.active &&
            (isMyMentee ||
              hasRole(me, "leadership") ||
              hasRole(me, "super_admin"))
          }
        />
        {employment && (
          <StudentEmploymentCard
            data={employment}
            studentId={student.id}
            canManageOverride={canManageEmployment}
          />
        )}
        <StudentMeetingsPanel
          studentId={student.id}
          schedules={schedules}
          allowedContexts={allowedContexts}
          reportable={reportable}
          initialOccurrenceId={meetingParam}
          autoOpenReport={autoOpenReport}
          isSuper={isSuper}
        />
      </div>

      {/* unified updates feed: messages + meeting reports + form submissions */}
      <div className="order-3 flex min-w-0 flex-col gap-4 lg:col-span-1 lg:col-start-1 lg:row-start-1 lg:row-span-2">
        {feedItems.length === 0 ? (
          <EmptyState title="אין עדכונים על החניך/ה עדיין"
            description="היו הראשונים לשלוח עדכון — השתמשו בכפתור הירוק למטה." />
        ) : (
          <UnifiedUpdatesFeed
            items={feedItems}
            canModerate={canModerate}
            showVisibilityStatus={canModerate || privileged}
            focusMessageId={focusMessageId}
            studentId={student.id}
            canEditReports={isSuper}
            currentStaffId={me.staffId}
            isSuperAdmin={isSuper}
            readOnly={viewAs.active}
          />
        )}

        <Composer studentId={student.id} canModerate={canModerate} />
      </div>
    </div>
  );
}
