import Link from "next/link";
import { cookies } from "next/headers";
import { requireMe, isPrivileged } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/format";
import { WEEKDAY_SHORT_LABELS } from "@/lib/meetings";
import { ROLE_LABELS } from "@/lib/constants";
import { getViewAsState } from "@/lib/view-as";
import StudentRow, { type StudentRowData } from "@/components/StudentRow";
import StudentDataTable, { type StudentTableRow } from "@/components/tables/StudentDataTable";
import EmptyState from "@/components/EmptyState";

export interface DashboardRow {
  student_id: string;
  student_name: string;
  group_name: string | null;
  has_project: boolean;
  project_major_name: string | null;
  intent_text: string | null;
  primary_master_name: string | null;
  master_names: string | null;
  status: string | null;
  status_source: string | null;
  last_report_at: string | null;
  intervention: boolean | null;
  mentor_last_meeting_at: string | null;
  mentor_last_status: string | null;
  master_last_meeting_at: string | null;
  master_last_status: string | null;
  mentor_next_meeting_at: string | null;
  mentor_next_meeting_weekday: number | null;
  mentor_next_meeting_time: string | null;
  master_next_meeting_at: string | null;
  master_next_meeting_weekday: number | null;
  master_next_meeting_time: string | null;
  in_my_groups: boolean;
  master_assigned: boolean;
  in_my_majors: boolean;
  broad_viewer: boolean;
}

const STATUS_LABELS: Record<string, string> = { green: "ירוק", yellow: "צהוב", red: "אדום" };
const STATUS_STYLES: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800 border-emerald-300",
  yellow: "bg-amber-100 text-amber-800 border-amber-300",
  red: "bg-red-100 text-red-800 border-red-300",
};

export default async function HomePage() {
  const me = await requireMe();
  const supabase = await createClient();
  const viewAs = await getViewAsState();

  // when View-As is active, use the target staff + context for scoping
  const useViewAs = Boolean(viewAs.active && viewAs.staffId && viewAs.roleContext);
  const dashRes = useViewAs
    ? await supabase.rpc("dashboard_rows_view_as", {
        p_target_staff_id: viewAs.staffId!,
        p_context: viewAs.roleContext!,
      })
    : await supabase.rpc("dashboard_rows");

  const [unreadRes, myStudentsRes, studentsRes, groupsRes, majorsRes, unreadCountsRes] =
    await Promise.all([
      supabase.rpc("unread_messages", { p_limit: 6, p_offset: 0 }),
      supabase.rpc("my_students"),
      supabase
        .from("students")
        .select("id, first_name, last_name, group_id, major_id, greenhouse_groups(name), majors(name)")
        .eq("is_archived", false),
      supabase.from("greenhouse_groups").select("id, name"),
      supabase.from("majors").select("id, name"),
      supabase.rpc("student_unread_counts"),
    ]);

  const unreadRows = (unreadRes.data ?? []) as Array<{
    message_id: string;
    student_id: string;
    student_first_name: string;
    student_last_name: string;
    author_name: string | null;
    body: string;
    created_at: string;
  }>;

  const unreadByStudent = new Map<string, number>();
  for (const row of unreadCountsRes.data ?? []) {
    unreadByStudent.set(row.student_id, Number(row.unread_count));
  }

  const studentById = new Map<string, StudentRowData>();
  for (const s of studentsRes.data ?? []) {
    const row = s as unknown as {
      id: string; first_name: string; last_name: string;
      greenhouse_groups: { name: string } | null; majors: { name: string } | null;
    };
    studentById.set(row.id, {
      id: row.id, firstName: row.first_name, lastName: row.last_name,
      groupName: row.greenhouse_groups?.name ?? null, majorName: row.majors?.name ?? null,
      unread: unreadByStudent.get(row.id) ?? 0,
    });
  }

  const myStudentIds = new Set<string>(
    ((myStudentsRes.data ?? []) as Array<{ id: string }>).map((s) => s.id)
  );
  const myStudents = [...myStudentIds]
    .map((id) => studentById.get(id))
    .filter((s): s is StudentRowData => Boolean(s))
    .sort((a, b) => b.unread - a.unread);

  const groups = (groupsRes.data ?? []).map((g) => ({
    id: g.id, name: g.name,
    unread: [...studentById.values()].filter((s) => s.groupName === g.name).reduce((sum, s) => sum + s.unread, 0),
  }));
  const majors = (majorsRes.data ?? []).map((m) => ({
    id: m.id, name: m.name,
    unread: [...studentById.values()].filter((s) => s.majorName === m.name).reduce((sum, s) => sum + s.unread, 0),
  }));

  const totalUnread = [...unreadByStudent.values()].reduce((a, b) => a + b, 0);
  const privileged = isPrivileged(me);
  const roleChips = me.roles.map((r) => ROLE_LABELS[r]).join(" · ");

  // dashboard rows — View-As rows have no flag columns
  const dashRows = ((dashRes.data ?? []) as DashboardRow[]);
  const groupRows = dashRows.filter((r) => r.in_my_groups !== false);
  const masterRows = dashRows.filter((r) => r.master_assigned !== false);
  const majorRows = dashRows.filter((r) => r.in_my_majors !== false);
  const broadRows = dashRows.filter((r) => r.broad_viewer !== false);

  const useViewAsDash = useViewAs && viewAs.roleContext !== "staff";

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-xl font-extrabold">שלום {me.fullName ?? "צוות"}</h1>
        <p className="mt-1 text-sm text-muted">{roleChips}</p>
      </section>

      {/* mobile-only global search entry — on desktop the student table has
          its own search/filter toolbar (exactly one student search) */}
      <Link
        href="/search"
        className="flex min-h-[52px] items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-muted hover:bg-brand-soft/40 lg:hidden"
      >
        <SearchGlyph />
        <span>חיפוש חניך…</span>
      </Link>

      {/* עדכונים — renders ABOVE the student table on desktop */}
      <section aria-labelledby="unread-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="unread-heading" className="font-extrabold">
            עדכונים שלא נקראו
            {totalUnread > 0 && (
              <span className="mr-2 rounded-full bg-brand px-2 py-0.5 text-xs font-extrabold text-ink">{totalUnread}</span>
            )}
          </h2>
          <Link href="/updates" className="text-sm font-medium text-muted hover:text-ink">הכל ›</Link>
        </div>
        {unreadRows.length === 0 ? (
          <EmptyState title="הכל נקרא" description="אין עדכונים חדשים. כשיתקבל עדכון רלוונטי הוא יופיע כאן." />
        ) : (
          <ul className="flex flex-col gap-2">
            {unreadRows.map((row) => (
              <li key={row.message_id}>
                <Link href={`/students/${row.student_id}?m=${row.message_id}`}
                  className="flex items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40">
                  <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-dark" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold">{row.student_first_name} {row.student_last_name}</span>
                    <span className="block truncate text-sm text-muted">{row.body}</span>
                    <span className="mt-0.5 block text-xs text-muted">{row.author_name ?? "צוות"} · {timeAgo(row.created_at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* desktop dashboards with sorting/filtering/search — below עדכונים */}
      {!useViewAsDash && broadRows.length > 0 ? (
        <div className="hidden flex-col gap-6 lg:flex">
          <StudentDataTable title="כל החניכים" rows={broadRows}
            columns={["student_name","group_name","project_major_name","primary_master_name","status","last_report_at","intervention","mentor_next_meeting_at","master_next_meeting_at"]} readOnly={useViewAs} />
        </div>
      ) : !useViewAsDash ? (
        <div className="hidden flex-col gap-6 lg:flex">
          {groupRows.length > 0 && (
            <StudentDataTable title="החניכים שלי · מנטור" rows={groupRows}
              columns={["student_name","group_name","status","last_report_at","intervention","mentor_next_meeting_at"]} readOnly={useViewAs} />
          )}
          {masterRows.length > 0 && (
            <StudentDataTable title="החניכים שלי · מאסטר" rows={masterRows}
              columns={["student_name","group_name","project_major_name","primary_master_name","status","last_report_at","intervention","master_next_meeting_at"]} readOnly={useViewAs} />
          )}
          {majorRows.length > 0 && (
            <StudentDataTable title="החניכים שלי · ראש/י מגמה" rows={majorRows}
              columns={["student_name","group_name","project_major_name","primary_master_name","status","last_report_at","intervention"]} readOnly={useViewAs} />
          )}
          {groupRows.length + masterRows.length + majorRows.length === 0 && (
            <EmptyState title="לוח הדשבורד יתמלא עם השיוכים שלכם"
              description="כשתשויכו כמנטור/ית, מאסטר/ית או ראש/ית מגמה — החניכים הרלוונטיים יופיעו כאן." />
          )}
        </div>
      ) : useViewAsDash ? (
        <div className="flex flex-col gap-6">
          {viewAs.roleContext === "staff" ? (
            <EmptyState title="תצוגת צוות כללי"
              description="צופה כאיש/אשת צוות רגיל — ללא דשבורד תפקידי." />
          ) : (
            <StudentDataTable
              title={`צפייה כ־${viewAs.staffName} · ${viewAs.roleContext}`}
              rows={dashRows}
              columns={["student_name","group_name","project_major_name","primary_master_name","status","last_report_at","intervention","mentor_next_meeting_at","master_next_meeting_at"]}
              readOnly={true}
            />
          )}
        </div>
      ) : null}

      <section aria-labelledby="my-students-heading" className="lg:hidden">
        <h2 id="my-students-heading" className="mb-2 font-extrabold">החניכים שלי</h2>
        {myStudents.length === 0 ? (
          <EmptyState title={privileged ? "גישה לכל החניכים" : "אין חניכים משויכים"}
            description={privileged ? "בתור צוות מוביל יש לכם גישה לכל החניכים — חפשו חניך או עברו דרך הקבוצות."
              : "חניכים יופיעו כאן לפי השתייכותכם כמנטור, מאסטר או ראש מגמה. תמיד אפשר לחפש כל חניך."} />
        ) : (
          <ul className="flex flex-col gap-2">
            {myStudents.slice(0, 8).map((s) => <StudentRow key={s.id} student={s} showGroup />)}
          </ul>
        )}
        {myStudents.length > 8 && (
          <p className="mt-2 text-sm text-muted">ועוד {myStudents.length - 8} חניכים — השתמשו בחיפוש או בקבוצות.</p>
        )}
      </section>

      <section aria-labelledby="groups-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="groups-heading" className="font-extrabold">קבוצות</h2>
          <Link href="/groups" className="text-sm font-medium text-muted hover:text-ink">הכל ›</Link>
        </div>
        <ul className="flex flex-wrap gap-2">
          {groups.slice(0, 8).map((g) => (
            <li key={g.id}>
              <Link href={`/groups/${g.id}`}
                className="flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 font-medium hover:bg-brand-soft/40">
                {g.name}
                {g.unread > 0 && <span className="rounded-full bg-brand px-2 text-xs font-extrabold text-ink">{g.unread}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="majors-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="majors-heading" className="font-extrabold">מגמות</h2>
          <Link href="/majors" className="text-sm font-medium text-muted hover:text-ink">הכל ›</Link>
        </div>
        <ul className="flex flex-wrap gap-2">
          {majors.map((m) => (
            <li key={m.id}>
              <Link href={`/majors/${m.id}`}
                className="flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 font-medium hover:bg-brand-soft/40">
                {m.name}
                {m.unread > 0 && <span className="rounded-full bg-brand px-2 text-xs font-extrabold text-ink">{m.unread}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}
