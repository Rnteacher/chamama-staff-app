import Link from "next/link";
import { requireMe, hasRole } from "@/lib/auth";
import { getViewAsState } from "@/lib/view-as";
import { createClient } from "@/lib/supabase/server";
import { jerusalemParts } from "@/lib/meetings";
import { isoDate } from "@/lib/schedule";
import {
  attendanceCounts,
  formatReportedProgressHe,
  type SchoolAttendanceRosterRow,
} from "@/lib/attendance";
import SchoolAttendanceConversational from "@/components/attendance/SchoolAttendanceConversational";
import SchoolAttendanceTable from "@/components/attendance/SchoolAttendanceTable";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "נוכחות היום" };

interface RosterRpcRow {
  student_id: string;
  first_name: string;
  last_name: string;
  effective: SchoolAttendanceRosterRow["effective"];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AttendancePage({
  searchParams,
}: PageProps<"/attendance">) {
  const me = await requireMe();
  const viewAs = await getViewAsState();
  const supabase = await createClient();

  const sp = await searchParams;
  const jp = jerusalemParts(new Date());
  const today = isoDate(jp.year, jp.month, jp.day);
  const date = typeof sp.date === "string" && DATE_RE.test(sp.date) ? sp.date : today;

  const isBroad = hasRole(me, "leadership") || hasRole(me, "super_admin");

  // writable groups: home-group mentors see THEIR groups; leadership /
  // super_admin see all. (The RPCs enforce the same server-side.)
  const [mentoredRes, allGroupsRes] = await Promise.all([
    supabase
      .from("group_mentors")
      .select("group_id, greenhouse_groups(id, name)")
      .eq("staff_id", me.staffId ?? ""),
    supabase.from("greenhouse_groups").select("id, name").order("name"),
  ]);

  interface GroupRef { id: string; name: string }
  let groups: GroupRef[] = [];
  if (isBroad) {
    groups = ((allGroupsRes.data ?? []) as unknown as GroupRef[]);
  } else {
    groups = ((mentoredRes.data ?? []) as unknown as Array<{
      group_id: string; greenhouse_groups: GroupRef | null;
    }>)
      .map((r) => r.greenhouse_groups)
      .filter((g): g is GroupRef => Boolean(g));
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        title="אין קבוצות לדיווח נוכחות"
        description="דיווח נוכחות יומי זמין למנטורים של קבוצות האם, להנהלה ולמנהל המערכת."
      />
    );
  }

  const requested = typeof sp.group === "string" ? sp.group : "";
  const group = groups.find((g) => g.id === requested) ?? groups[0];

  const [rosterRes, countsRes] = await Promise.all([
    supabase.rpc("school_attendance_roster", { p_group_id: group.id, p_date: date }),
    supabase.rpc("school_attendance_counts", { p_group_id: group.id, p_date: date }),
  ]);

  const roster = ((rosterRes.data ?? []) as unknown as RosterRpcRow[]).map((r) => ({
    student_id: r.student_id,
    first_name: r.first_name,
    last_name: r.last_name,
    effective: r.effective,
  }));
  const counts = attendanceCounts(roster);
  const progressLabel =
    (countsRes.data as { resolved?: number; total?: number } | null) ?? counts;

  const countsChips: { label: string; value: number; cls: string }[] = [
    { label: "נוכחים", value: counts.present, cls: "bg-emerald-50 text-emerald-900 border-emerald-300" },
    { label: "חסרים", value: counts.absent, cls: "bg-red-50 text-red-900 border-red-300" },
    { label: "מאחרים", value: counts.late, cls: "bg-amber-50 text-amber-900 border-amber-300" },
    { label: "בעבודה", value: counts.working, cls: "bg-bg text-muted border-line" },
    { label: "טרם דווחו", value: counts.unresolved, cls: "bg-bg text-muted border-dashed border-muted" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-extrabold">נוכחות יומית</h1>
          {isBroad && (
            <Link
              href="/attendance/overview"
              className="rounded-full border border-line px-4 py-2 text-sm font-bold text-muted hover:bg-bg"
            >
              סקירת כל הקבוצות ›
            </Link>
          )}
        </div>

        {/* date + group pickers (server round-trip via query params) */}
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-bold">
            תאריך
            <input
              type="date"
              name="date"
              defaultValue={date}
              className="mr-2 rounded-xl border border-line bg-surface px-3 py-2"
            />
          </label>
          <label className="text-sm font-bold">
            קבוצה
            <select
              name="group"
              defaultValue={group.id}
              className="mr-2 rounded-xl border border-line bg-surface px-3 py-2"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-full bg-ink px-4 py-2 text-sm font-extrabold text-white"
          >
            הצגה
          </button>
        </form>

        {/* completion + counts */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-brand-dark bg-brand-soft px-3 py-1 text-sm font-extrabold">
            {formatReportedProgressHe({
              ...counts,
              resolved: progressLabel.resolved ?? counts.resolved,
              total: progressLabel.total ?? counts.total,
            })}
          </span>
          {countsChips.map((c) => (
            <span key={c.label} className={`rounded-full border px-3 py-1 text-xs font-bold ${c.cls}`}>
              {c.label}: {c.value}
            </span>
          ))}
        </div>
      </header>

      {/* MOBILE: conversational one-by-one flow (primary fast workflow) */}
      <div className="lg:hidden">
        <SchoolAttendanceConversational
          students={roster}
          date={date}
          readOnly={viewAs.active}
        />
      </div>

      {/* DESKTOP: wide table (never the conversational flow) */}
      <div className="hidden lg:block">
        <SchoolAttendanceTable
          students={roster}
          date={date}
          groupId={group.id}
          readOnly={viewAs.active}
        />
      </div>
    </div>
  );
}
