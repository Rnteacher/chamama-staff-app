import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe, isPrivileged } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/format";
import FeedClient, { type FeedMessage } from "@/components/FeedClient";
import Composer from "@/components/Composer";
import MarkAllReadButton from "@/components/MarkStudentReadButton";
import StudentMeetingsPanel, {
  type ScheduleRow,
  type ReportableOccurrence,
} from "@/components/meetings/StudentMeetingsPanel";
import EmptyState from "@/components/EmptyState";

const PAGE_SIZE = 30;

export const metadata = { title: "חניך" };

export default async function StudentPage({
  params,
  searchParams,
}: PageProps<"/students/[id]">) {
  const me = await requireMe();
  const { id } = await params;
  const sp = await searchParams;
  const focusMessageId = typeof sp.m === "string" ? sp.m : undefined;
  const page = Math.max(0, Number(typeof sp.page === "string" ? sp.page : "0") || 0);

  const supabase = await createClient();

  const studentRes = await supabase
    .from("students")
    .select(
      "id, first_name, last_name, is_archived, group_id, major_id, greenhouse_groups(id, name), majors(id, name)"
    )
    .eq("id", id)
    .maybeSingle();

  const student = studentRes.data as unknown as
    | {
        id: string;
        first_name: string;
        last_name: string;
        is_archived: boolean;
        group_id: string | null;
        major_id: string | null;
        greenhouse_groups: { id: string; name: string } | null;
        majors: { id: string; name: string } | null;
      }
    | null;

  if (!student) notFound();

  const [mentorsRes, mastersRes, messagesRes, readsRes, countsRes, myMentorRes, myMasterRes, schedulesRes, reportableRes] =
    await Promise.all([
      student.group_id
        ? supabase
            .from("group_mentors")
            .select("profiles(id, full_name)")
            .eq("group_id", student.group_id)
        : Promise.resolve({ data: [] as never[] }),
      supabase
        .from("master_assignments")
        .select("profiles(id, full_name)")
        .eq("student_id", student.id),
      supabase
        .from("student_messages")
        .select(
          "id, author_staff_id, body, created_at, updated_at, is_general_visible, is_hidden_from_leads, general_visible_by, general_visible_at, restriction_changed_by, restriction_changed_at, profiles!student_messages_author_staff_id_fkey(full_name)"
        )
        .eq("student_id", student.id)
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
      supabase
        .from("message_reads")
        .select("message_id")
        .eq("staff_id", me.staffId!),
      supabase.rpc("student_unread_counts"),
      student.group_id
        ? supabase
            .from("group_mentors")
            .select("group_id")
            .eq("group_id", student.group_id)
            .eq("staff_id", me.staffId!)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("master_assignments")
        .select("student_id")
        .eq("student_id", student.id)
        .eq("staff_id", me.staffId!)
        .maybeSingle(),
      supabase
        .from("meeting_schedules")
        .select("id, staff_id, context, weekday, meeting_time, is_active, profiles(full_name)")
        .eq("student_id", student.id)
        .order("weekday"),
      supabase.rpc("my_reportable_occurrences", { p_student_id: student.id }),
    ]);

  const readIds = new Set<string>((readsRes.data ?? []).map((r) => r.message_id));
  const unreadCount =
    Number(
      ((countsRes.data ?? []) as Array<{ student_id: string; unread_count: number }>).find(
        (c) => c.student_id === student.id
      )?.unread_count ?? 0
    ) || 0;

  const canModerate = Boolean(myMentorRes.data);
  const privileged = isPrivileged(me);

  const mentorNames = (mentorsRes.data ?? [])
    .map((m) => (m as unknown as { profiles: { id: string; full_name: string | null } | null }).profiles?.full_name)
    .filter((n): n is string => Boolean(n));

  const masterNames = (mastersRes.data ?? [])
    .map((m) => (m as unknown as { profiles: { id: string; full_name: string | null } | null }).profiles?.full_name)
    .filter((n): n is string => Boolean(n));

  // meetings: who may schedule, what exists, what is reportable
  const isSuper = me.roles.includes("super_admin");
  const allowedContexts: ("mentor" | "master")[] = [
    ...(myMentorRes.data || isSuper ? (["mentor"] as const) : []),
    ...(myMasterRes.data || isSuper ? (["master"] as const) : []),
  ];

  const schedules: ScheduleRow[] = (schedulesRes.data ?? []).map((s) => {
    const row = s as unknown as {
      id: string;
      staff_id: string;
      context: "mentor" | "master";
      weekday: number;
      meeting_time: string;
      is_active: boolean;
      profiles: { full_name: string | null } | null;
    };
    return {
      id: row.id,
      context: row.context,
      weekday: row.weekday,
      meetingTime: row.meeting_time.slice(0, 5),
      isActive: row.is_active,
      staffName: row.profiles?.full_name ?? "צוות",
      mine: row.staff_id === me.staffId,
    };
  });

  const reportable: ReportableOccurrence[] = (
    (reportableRes.data ?? []) as Array<{
      occurrence_id: string;
      due_at: string;
      context: "mentor" | "master";
    }>
  ).map((row) => ({
    occurrenceId: row.occurrence_id,
    dueAt: row.due_at,
    context: row.context,
  }));

  const meetingParam = typeof sp.meeting === "string" ? sp.meeting : undefined;
  const autoOpenReport = sp.report === "1";

  const messages: FeedMessage[] = (messagesRes.data ?? []).map((m) => {
    const row = m as unknown as {
      id: string;
      author_staff_id: string;
      body: string;
      created_at: string;
      updated_at: string;
      is_general_visible: boolean;
      is_hidden_from_leads: boolean;
      general_visible_by: string | null;
      general_visible_at: string | null;
      restriction_changed_by: string | null;
      restriction_changed_at: string | null;
      profiles: { full_name: string | null } | null;
    };
    return {
      id: row.id,
      authorId: row.author_staff_id,
      authorName: row.profiles?.full_name ?? "צוות",
      body: row.body,
      createdAt: row.created_at,
      createdAtLabel: timeAgo(row.created_at),
      updatedAtLabel:
        row.updated_at && row.updated_at !== row.created_at
          ? timeAgo(row.updated_at)
          : null,
      isGeneralVisible: row.is_general_visible,
      isHiddenFromLeads: row.is_hidden_from_leads,
      read: readIds.has(row.id),
      mine: row.author_staff_id === me.staffId,
    };
  });

  const totalMessagesRes = await supabase
    .from("student_messages")
    .select("id", { count: "exact", head: true })
    .eq("student_id", student.id);
  const totalMessages = totalMessagesRes.count ?? 0;
  const hasMore = totalMessages > (page + 1) * PAGE_SIZE;

  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-extrabold">
              {student.first_name} {student.last_name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted">
              {student.greenhouse_groups && (
                <Link
                  href={`/groups/${student.greenhouse_groups.id}`}
                  className="font-medium text-ink underline-offset-2 hover:underline"
                >
                  {student.greenhouse_groups.name}
                </Link>
              )}
              {student.majors && (
                <>
                  <span aria-hidden="true">·</span>
                  <Link
                    href={`/majors/${student.majors.id}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {student.majors.name}
                  </Link>
                </>
              )}
            </p>
          </div>
          {student.is_archived && (
            <span className="shrink-0 rounded-full border border-warn px-2.5 py-1 text-xs font-bold text-warn">
              ארכיון
            </span>
          )}
        </div>

        <dl className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          <div className="flex gap-1">
            <dt className="font-bold">מנטורים:</dt>
            <dd className="text-muted">
              {mentorNames.length > 0 ? mentorNames.join(", ") : "—"}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="font-bold">מאסטרים:</dt>
            <dd className="text-muted">
              {masterNames.length > 0 ? masterNames.join(", ") : "—"}
            </dd>
          </div>
        </dl>

        {unreadCount > 0 && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-brand-soft px-3 py-2">
            <span className="text-sm font-bold">
              {unreadCount} עדכונים שלא נקראו
            </span>
            <MarkAllReadButton studentId={student.id} label="סמן הכל כנקרא" />
          </div>
        )}
      </header>

      <StudentMeetingsPanel
        studentId={student.id}
        schedules={schedules}
        allowedContexts={allowedContexts}
        reportable={reportable}
        initialOccurrenceId={meetingParam}
        autoOpenReport={autoOpenReport}
      />

      {messages.length === 0 && page === 0 ? (
        <EmptyState
          title="אין עדכונים על החניך/ה עדיין"
          description="היו הראשונים לשלוח עדכון — השתמשו בכפתור הירוק למטה."
        />
      ) : (
        <FeedClient
          studentId={student.id}
          messages={messages}
          canModerate={canModerate}
          showVisibilityStatus={canModerate || privileged}
          focusMessageId={focusMessageId}
          hasMore={hasMore}
          page={page}
        />
      )}

      <Composer studentId={student.id} canModerate={canModerate} />
    </div>
  );
}
