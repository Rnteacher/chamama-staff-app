import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { WEEKDAY_SHORT_LABELS, jerusalemParts } from "@/lib/meetings";
import { ROLE_LABELS } from "@/lib/constants";
import { getViewAsState } from "@/lib/view-as";
import { getUnreadCounts } from "@/lib/unread";
import { fetchStaffDay } from "@/lib/calendar";
import { scopeHomeStudents } from "@/lib/home-students";
import {
  isoDate,
  sortScheduleItems,
  isNow,
  formatWeeklySlotHe,
  type ScheduleItem,
  type WeeklySlot,
} from "@/lib/schedule";
import HomeStudentsPanel from "@/components/home/HomeStudentsPanel";
import StudentDataTable from "@/components/tables/StudentDataTable";
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

export default async function HomePage() {
  const supabase = await createClient();
  const jp = jerusalemParts(new Date());
  const todayISO = isoDate(jp.year, jp.month, jp.day);

  // ---- wave 1: nothing here depends on who the caller is beyond the
  // session itself (RLS-scoped reads), so it starts together with the shared
  // identity / View-As / unread lookups instead of after them. Nothing is
  // rendered before requireMe() below has passed.
  const unreadP = getUnreadCounts();
  const listsP = Promise.all([
    supabase
      .from("students")
      .select("id, first_name, last_name, group_id, major_id, greenhouse_groups(name), majors(name)")
      .eq("is_archived", false),
    supabase.from("greenhouse_groups").select("id, name"),
    supabase.from("majors").select("id, name"),
    supabase.rpc("learning_groups_on_weekday", { p_weekday: jp.weekday }),
  ]);
  // the caller's own major-head students (canonical major_heads relationship,
  // keyed on the session in the database — roles grant nothing here)
  const majorIdsP = supabase.rpc("home_major_student_ids");
  const [me, viewAs, majorIdsRes] = await Promise.all([
    requireMe(),
    getViewAsState(),
    majorIdsP,
  ]);

  // when View-As is active, use the target staff + context for scoping
  const useViewAs = Boolean(viewAs.active && viewAs.staffId && viewAs.roleContext);

  // canonical relationships decide the Home student lists (NEVER the role
  // list): the real user's group_mentors / master_assignments arrive with
  // the identity (current_staff_context), major_heads via
  // home_major_student_ids. View-As never renders these lists.
  const mentoredGroupIds = new Set(useViewAs ? [] : me.mentorGroupIds);
  const masteredStudentIds = new Set(useViewAs ? [] : me.masterStudentIds);
  if (majorIdsRes.error) {
    console.error("[home] home_major_student_ids unavailable:", majorIdsRes.error.message);
  }
  const majorHeadStudentIds = new Set(
    useViewAs
      ? []
      : ((majorIdsRes.data ?? []) as { student_id: string }[]).map((r) => r.student_id)
  );

  // The relationship dashboard is only DISPLAYED for mentor/master/major rows
  // (or the View-As role table) — skip the RPC for everyone else.
  const needsDashboard = useViewAs
    ? viewAs.roleContext !== "staff"
    : mentoredGroupIds.size > 0 ||
      masteredStudentIds.size > 0 ||
      majorHeadStudentIds.size > 0;

  // ---- wave 2: everything keyed by the resolved staff member, in parallel
  const scheduleStaffId = useViewAs ? viewAs.staffId! : me.staffId;
  // ONLY actual home-group mentors get school-attendance cards (View-As stays
  // read-only and never shows them).
  const attendanceGroupIds = useViewAs ? [] : me.mentorGroupIds;
  const [dashRes, myDayRes, myLgRes, attendanceCounts] = await Promise.all([
    needsDashboard
      ? useViewAs
        ? supabase.rpc("dashboard_rows_view_as", {
            p_target_staff_id: viewAs.staffId!,
            p_context: viewAs.roleContext!,
          })
        : supabase.rpc("dashboard_rows")
      : Promise.resolve({ data: [] as DashboardRow[] }),
    scheduleStaffId
      ? fetchStaffDay(supabase, scheduleStaffId, todayISO)
      : Promise.resolve([]),
    scheduleStaffId
      ? supabase.rpc("staff_learning_groups_on_weekday", {
          p_staff_id: scheduleStaffId,
          p_weekday: jp.weekday,
        })
      : Promise.resolve({ data: [] as never[] }),
    Promise.all(
      attendanceGroupIds.map(async (groupId) => {
        const { data } = await supabase.rpc("school_attendance_counts", {
          p_group_id: groupId,
          p_date: todayISO,
        });
        return [
          groupId,
          (data ?? {}) as { resolved: number; total: number; absent: number; late: number },
        ] as const;
      })
    ),
  ]);
  const [[studentsRes, groupsRes, majorsRes, lgTodayRes], unreadByStudent] =
    await Promise.all([listsP, unreadP]);

  interface StudentBasic {
    id: string;
    firstName: string;
    lastName: string;
    groupId: string | null;
    groupName: string | null;
    majorName: string | null;
    unread: number;
  }
  const studentById = new Map<string, StudentBasic>();
  for (const s of studentsRes.data ?? []) {
    const row = s as unknown as {
      id: string; first_name: string; last_name: string; group_id: string | null;
      greenhouse_groups: { name: string } | null; majors: { name: string } | null;
    };
    studentById.set(row.id, {
      id: row.id, firstName: row.first_name, lastName: row.last_name,
      groupId: row.group_id,
      groupName: row.greenhouse_groups?.name ?? null, majorName: row.majors?.name ?? null,
      unread: unreadByStudent.get(row.id) ?? 0,
    });
  }

  // students of the home groups this person actually mentors
  const mentoredStudentIds = new Set<string>();
  for (const s of studentById.values()) {
    if (s.groupId && mentoredGroupIds.has(s.groupId)) {
      mentoredStudentIds.add(s.id);
    }
  }

  // ------------------------- היום שלי + קבוצות למידה היום (unified day) -----
  const myDay = sortScheduleItems(myDayRes);

  // ------------------------------------------------ נוכחות (mentor-only) ---
  // ONLY actual home-group mentors get school-attendance cards, and only for
  // the group(s) they mentor. No other role (coordinator, master, major head,
  // super_admin…) receives school-attendance cards — leadership reaches the
  // overview through the navigation instead. View-As stays read-only.
  interface MentoredGroup { id: string; name: string }
  const groupNameById = new Map(
    ((groupsRes.data ?? []) as MentoredGroup[]).map((g) => [g.id, g.name])
  );
  const attendanceGroups: MentoredGroup[] = attendanceGroupIds
    .filter((id) => groupNameById.has(id))
    .map((id) => ({ id, name: groupNameById.get(id)! }));
  const attendanceCountsByGroup = new Map(attendanceCounts);

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

  const isCalendarAdmin = me.roles.includes("leadership") || me.roles.includes("super_admin");
  // functional roles only — the implicit base "staff" identity is not a role chip
  const functionalRoles = me.roles.filter((r) => r !== "staff");
  const roleChips = functionalRoles.map((r) => ROLE_LABELS[r]).join(" · ");

  // relationship-scoped student lists (mentor / master / major head)
  const dashRows = ((dashRes.data ?? []) as DashboardRow[]);
  const scoped = scopeHomeStudents(
    dashRows,
    mentoredStudentIds,
    masteredStudentIds,
    majorHeadStudentIds
  );
  const toMobile = (rows: DashboardRow[]) =>
    rows
      .map((r) => {
        const s = studentById.get(r.student_id);
        return s
          ? {
              id: s.id, firstName: s.firstName, lastName: s.lastName,
              groupName: s.groupName, majorName: s.majorName, unread: s.unread,
            }
          : null;
      })
      .filter((s): s is NonNullable<typeof s> => Boolean(s));

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-xl font-extrabold">שלום {me.fullName ?? "צוות"}</h1>
        {roleChips && <p className="mt-1 text-sm text-muted">{roleChips}</p>}
      </section>

      {/* one global student search — every authenticated staff member, every viewport */}
      <Link
        href="/search"
        className="flex min-h-[52px] items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-muted hover:bg-brand-soft/40"
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
            <Link href="/calendar" prefetch={false} className="text-sm font-medium text-muted hover:text-ink">
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

      {/* -------------------------------------- נוכחות (mentor-only entry) */}
      {!useViewAs && (attendanceGroups.length > 0 || myLgSessions.length > 0) && (
        <section aria-labelledby="attendance-heading">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="attendance-heading" className="font-extrabold">
              נוכחות היום
            </h2>
            {isCalendarAdmin && (
              <Link href="/attendance/overview" prefetch={false} className="text-sm font-medium text-muted hover:text-ink">
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
                        נוכחות הקבוצה · {g.name}
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
                    href={`/groups/learning/${g.id}`} prefetch={false}
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

      {/* ---------------- החניכים שלי (mentor / master / major head only) -- */}
      {!useViewAs && (
        <HomeStudentsPanel
          mentorRows={scoped.mentorRows}
          masterRows={scoped.masterRows}
          majorRows={scoped.majorRows}
          mentorMobile={toMobile(scoped.mentorRows)}
          masterMobile={toMobile(scoped.masterRows)}
          majorMobile={toMobile(scoped.majorRows)}
        />
      )}

      {/* View-As: a read-only context dashboard (never the real person's lists) */}
      {useViewAs && (
        <section aria-labelledby="my-students-heading">
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
        </section>
      )}

      <section aria-labelledby="groups-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="groups-heading" className="font-extrabold">קבוצות</h2>
          <Link href="/groups" prefetch={false} className="text-sm font-medium text-muted hover:text-ink">הכל ›</Link>
        </div>
        <ul className="flex flex-wrap gap-2">
          {groups.slice(0, 8).map((g) => (
            <li key={g.id}>
              <Link href={`/groups/${g.id}`} prefetch={false}
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
          <Link href="/majors" prefetch={false} className="text-sm font-medium text-muted hover:text-ink">הכל ›</Link>
        </div>
        <ul className="flex flex-wrap gap-2">
          {majors.map((m) => (
            <li key={m.id}>
              <Link href={`/majors/${m.id}`} prefetch={false}
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
    <Link href={item.linkPath} prefetch={false} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
