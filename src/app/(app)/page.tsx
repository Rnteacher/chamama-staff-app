import Link from "next/link";
import { cookies } from "next/headers";
import { requireMe, isPrivileged } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/format";
import { WEEKDAY_SHORT_LABELS, jerusalemParts } from "@/lib/meetings";
import { ROLE_LABELS } from "@/lib/constants";
import { getViewAsState } from "@/lib/view-as";
import { fetchStaffDay } from "@/lib/calendar";
import {
  isoDate,
  sortScheduleItems,
  isNow,
  formatWeeklySlotHe,
  type ScheduleItem,
  type WeeklySlot,
} from "@/lib/schedule";
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

  // ------------------------- היום שלי + קבוצות למידה היום (unified day) -----
  const jp = jerusalemParts(new Date());
  const todayISO = isoDate(jp.year, jp.month, jp.day);
  const scheduleStaffId = useViewAs ? viewAs.staffId! : me.staffId;
  const [myDayRes, lgTodayRes, myLgRes] = await Promise.all([
    scheduleStaffId
      ? fetchStaffDay(supabase, scheduleStaffId, todayISO)
      : Promise.resolve([]),
    supabase.rpc("learning_groups_on_weekday", { p_weekday: jp.weekday }),
    scheduleStaffId
      ? supabase.rpc("staff_learning_groups_on_weekday", {
          p_staff_id: scheduleStaffId,
          p_weekday: jp.weekday,
        })
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const myDay = sortScheduleItems(myDayRes);

  // ------------------------------------------------ נוכחות קבוצת האם -------
  // mentors (and leadership via the overview link) get today's completion
  // counts per writable group; ordinary staff see nothing they cannot use.
  const isBroad = me.roles.includes("leadership") || me.roles.includes("super_admin");
  interface MentoredGroup { id: string; name: string }
  let attendanceGroups: MentoredGroup[] = [];
  if (!useViewAs) {
    if (isBroad) {
      const { data: allGroups } = await supabase.from("greenhouse_groups").select("id, name").order("name");
      attendanceGroups = (allGroups ?? []) as MentoredGroup[];
    } else if (me.staffId) {
      const { data: mentored } = await supabase
        .from("group_mentors")
        .select("group_id, greenhouse_groups(id, name)")
        .eq("staff_id", me.staffId);
      attendanceGroups = ((mentored ?? []) as unknown as Array<{
        group_id: string; greenhouse_groups: MentoredGroup | null;
      }>)
        .map((r) => r.greenhouse_groups)
        .filter((g): g is MentoredGroup => Boolean(g));
    }
  }
  const attendanceCountsByGroup = new Map<
    string,
    { resolved: number; total: number; absent: number; late: number }
  >();
  await Promise.all(
    attendanceGroups.map(async (g) => {
      const { data } = await supabase.rpc("school_attendance_counts", {
        p_group_id: g.id,
        p_date: todayISO,
      });
      const c = (data ?? {}) as { resolved: number; total: number; absent: number; late: number };
      attendanceCountsByGroup.set(g.id, c);
    })
  );

  // LG sessions THIS staff member leads today (attendance entry point)
  const myLgSessions = ((myLgRes.data ?? []) as unknown as Array<{
    learning_group_id: string;
    group_name: string;
    start_time: string;
    end_time: string;
  }>);
  interface LgTodayRow {
    learning_group_id: string;
    group_name: string;
    is_active: boolean;
    start_time: string;
    end_time: string;
    staff_leader_names: string[] | null;
    student_leader_names: string[] | null;
  }
  const learningGroupsToday = ((lgTodayRes.data ?? []) as unknown as LgTodayRow[])
    .map((row) => ({
      id: row.learning_group_id,
      name: row.group_name,
      isActive: row.is_active,
      slot: {
        weekday: jp.weekday,
        startTime: row.start_time.slice(0, 5),
        endTime: row.end_time.slice(0, 5),
      } satisfies WeeklySlot,
      staffLeaders: row.staff_leader_names ?? [],
      studentLeaders: row.student_leader_names ?? [],
    }))
    .filter((g) => g.isActive)
    .sort((a, b) => a.slot.startTime.localeCompare(b.slot.startTime));

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
  const isCalendarAdmin = me.roles.includes("leadership") || me.roles.includes("super_admin");
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

      {/* --------------------------------------------------- היום שלי ---- */}
      <section aria-labelledby="my-day-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="my-day-heading" className="font-extrabold">
            היום שלי
            <span className="mr-2 text-sm font-medium text-muted">{WEEKDAY_SHORT_LABELS[jp.weekday]}</span>
          </h2>
          {/* full calendar MANAGEMENT is leadership/super_admin only — ordinary
              staff see their events here and in the daily schedule, without a
              management-calendar entry */}
          {isCalendarAdmin && (
            <Link href="/calendar" className="text-sm font-medium text-muted hover:text-ink">
              לוח שנה ›
            </Link>
          )}
        </div>
        {myDay.length === 0 ? (
          <EmptyState
            title="אין פעילות היום"
            description="אירועים, פגישות וקבוצות למידה של היום יופיעו כאן."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {myDay.map((item) => {
              const current = !item.isAllDay && isNow(item);
              // the calendar management screen is leadership/super_admin only —
              // strip calendar links from schedule items for everyone else
              const linkPath =
                item.linkPath?.startsWith("/calendar") && !isCalendarAdmin
                  ? null
                  : item.linkPath;
              return (
                <li key={`${item.sourceType}-${item.sourceId}-${item.startAt}`}>
                  <DayItemLink item={{ ...item, linkPath }} current={current} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* -------------------------------------- נוכחות (fast daily entry) */}
      {!useViewAs && (attendanceGroups.length > 0 || myLgSessions.length > 0) && (
        <section aria-labelledby="attendance-heading">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="attendance-heading" className="font-extrabold">
              נוכחות היום
            </h2>
            {isCalendarAdmin && (
              <Link href="/attendance/overview" className="text-sm font-medium text-muted hover:text-ink">
                סקירת כל הקבוצות ›
              </Link>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            {attendanceGroups.map((g) => {
              const c = attendanceCountsByGroup.get(g.id);
              return (
                <li key={g.id}>
                  <Link
                    href={`/attendance?group=${g.id}`}
                    className="flex min-h-[64px] items-center justify-between gap-3 rounded-2xl border-2 border-brand-dark bg-brand-soft/60 px-4 py-3 font-bold hover:bg-brand-soft"
                  >
                    <span className="min-w-0">
                      <span className="block text-base font-extrabold">
                        נוכחות קבוצת האם · {g.name}
                      </span>
                      {c && (
                        <span className="block truncate text-xs font-semibold text-ink/80">
                          {c.resolved}/{c.total} דווחו · {c.absent} חסרים · {c.late} מאחרים
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-extrabold text-white">
                      פתיחה ›
                    </span>
                  </Link>
                </li>
              );
            })}
            {myLgSessions.map((s) => (
              <li key={`${s.learning_group_id}-${s.start_time}`}>
                <div className="flex min-h-[56px] items-stretch gap-2">
                  <Link
                    href={`/groups/learning/${s.learning_group_id}/attendance?date=${todayISO}`}
                    className="flex flex-1 items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40"
                  >
                    <span className="min-w-0">
                      <span className="block font-bold">נוכחות קבוצת למידה · {s.group_name}</span>
                      <span className="block text-xs text-muted" dir="ltr">
                        {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-muted">פתיחה ›</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --------------------------------------- קבוצות למידה היום -------- */}
      <section aria-labelledby="lg-today-heading" className="lg:hidden">
        <h2 id="lg-today-heading" className="mb-2 font-extrabold">
          קבוצות למידה היום
        </h2>
        {learningGroupsToday.length === 0 ? (
          <EmptyState
            title="אין קבוצות למידה היום"
            description="קבוצות למידה שפועלות היום יופיעו כאן."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {learningGroupsToday.map((g) => {
              // staff leaders get a direct נוכחות action for today's session
              const leadsToday = myLgSessions.some((s) => s.learning_group_id === g.id);
              return (
                <li key={`${g.id}-${g.slot.startTime}`} className="flex items-stretch gap-2">
                  <Link
                    href={`/groups/learning/${g.id}`}
                    className="flex min-h-[56px] flex-1 items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40"
                  >
                    <span className="min-w-0">
                      <span className="block font-bold">{g.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {[
                          g.staffLeaders.length > 0 ? `מדריכים: ${g.staffLeaders.join(", ")}` : null,
                          g.studentLeaders.length > 0 ? `מובילים: ${g.studentLeaders.join(", ")}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-muted" dir="ltr">
                      {formatWeeklySlotHe(g.slot).replace(/^יום \S+ /, "")}
                    </span>
                  </Link>
                  {leadsToday && (
                    <Link
                      href={`/groups/learning/${g.id}/attendance?date=${todayISO}`}
                      className="flex min-h-[56px] shrink-0 items-center rounded-2xl border-2 border-brand-dark bg-brand-soft px-4 font-extrabold text-ink hover:bg-brand-soft/70"
                      aria-label={`נוכחות · ${g.name}`}
                    >
                      נוכחות
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {unreadRows.map((row) => (
              <li key={row.message_id}>
                <Link href={`/students/${row.student_id}?m=${row.message_id}`}
                  className="flex h-full items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40">
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

const SOURCE_GLYPHS: Record<string, string> = {
  calendar_event: "📅",
  meeting: "🗣",
  learning_group: "👥",
};

/** One unified-schedule item: all-day badge, times LTR, "עכשיו" highlight. */
function DayItemLink({ item, current }: { item: ScheduleItem; current: boolean }) {
  const timeLabel = (iso: string) =>
    new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));

  const inner = (
    <>
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {SOURCE_GLYPHS[item.sourceType] ?? "•"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold">
          {item.title}
          {current && (
            <span className="mr-2 rounded-full bg-brand px-2 py-0.5 text-[10px] font-extrabold text-ink">
              עכשיו
            </span>
          )}
          {item.isAllDay && (
            <span className="mr-2 rounded-full bg-line px-2 py-0.5 text-[10px] font-bold text-muted">
              כל היום
            </span>
          )}
        </span>
        {item.context && (
          <span className="block truncate text-xs text-muted">{item.context}</span>
        )}
      </span>
      {!item.isAllDay && (
        <span className="shrink-0 text-xs font-semibold text-muted" dir="ltr">
          {timeLabel(item.startAt)}–{timeLabel(item.endAt)}
        </span>
      )}
    </>
  );

  const cls = `flex min-h-[56px] items-center gap-3 rounded-2xl border px-4 py-3 hover:bg-brand-soft/40 ${
    current ? "border-brand-dark bg-brand-soft" : "border-line bg-surface"
  }`;

  return item.linkPath ? (
    <Link href={item.linkPath} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
