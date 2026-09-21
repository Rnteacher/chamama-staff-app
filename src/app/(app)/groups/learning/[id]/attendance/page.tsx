import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";
import { getViewAsState } from "@/lib/view-as";
import { createClient } from "@/lib/supabase/server";
import { jerusalemParts } from "@/lib/meetings";
import { isoDate } from "@/lib/schedule";
import LearningGroupAttendance, {
  type LgSessionEntry,
} from "@/components/attendance/LearningGroupAttendance";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "נוכחות קבוצת למידה" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * LEARNING GROUP attendance — per ACTUAL scheduled session (a group may hold
 * multiple slots on one day; each stays a distinct session). Roster = active
 * membership. School absence / expected-work propagate automatically from the
 * canonical school resolver. Staff leaders of THAT group, leadership and
 * super_admin record; student leaders get no app access at all.
 */
export default async function LearningGroupAttendancePage({
  params,
  searchParams,
}: PageProps<"/groups/learning/[id]/attendance">) {
  const me = await requireMe();
  const viewAs = await getViewAsState();
  const { id } = await params;
  const supabase = await createClient();

  const sp = await searchParams;
  const jp = jerusalemParts(new Date());
  const today = isoDate(jp.year, jp.month, jp.day);
  const date = typeof sp.date === "string" && DATE_RE.test(sp.date) ? sp.date : today;

  const [groupRes, leadersRes, sessionsRes] = await Promise.all([
    supabase
      .from("learning_groups")
      .select("id, name, is_active")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("learning_group_staff_leaders")
      .select("staff_id")
      .eq("learning_group_id", id),
    supabase.rpc("learning_group_attendance_for_date", {
      p_group_id: id,
      p_date: date,
    }),
  ]);

  const group = groupRes.data as unknown as {
    id: string; name: string; is_active: boolean;
  } | null;
  if (!group) notFound();

  const isStaffLeader = (leadersRes.data ?? []).some(
    (l) => (l as unknown as { staff_id: string }).staff_id === me.staffId
  );
  const canRecord =
    !viewAs.active &&
    (isStaffLeader || hasRole(me, "leadership") || hasRole(me, "super_admin"));

  const sessions = ((sessionsRes.data ?? []) as unknown) as LgSessionEntry[];

  // normalize arrival_time "HH:MM:SS" → "HH:MM" for display
  for (const s of sessions) {
    for (const e of s.roster) {
      if (e.arrival_time) e.arrival_time = e.arrival_time.slice(0, 5);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-extrabold">נוכחות · {group.name}</h1>
          {!group.is_active && (
            <span className="rounded-full bg-line px-2.5 py-1 text-xs font-bold text-muted">
              קבוצה לא פעילה
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/groups/learning/${group.id}`}
            className="text-sm font-medium text-muted hover:text-ink"
          >
            ‹ חזרה לקבוצה
          </Link>
          <form method="get" className="flex items-center gap-2">
            <label className="text-sm font-bold">
              תאריך
              <input
                type="date"
                name="date"
                defaultValue={date}
                className="mr-2 rounded-xl border border-line bg-surface px-3 py-1.5"
              />
            </label>
            <button
              type="submit"
              className="rounded-full bg-ink px-4 py-1.5 text-sm font-extrabold text-white"
            >
              הצגה
            </button>
          </form>
        </div>
      </header>

      {sessions.length === 0 ? (
        <EmptyState
          title="אין מפגש מתוכנן בתאריך זה"
          description="הנוכחות נרשמת לפי המפגשים השבועיים המוגדרים לקבוצה."
        />
      ) : (
        <LearningGroupAttendance
          groupId={group.id}
          date={date}
          sessions={sessions}
          readOnly={!canRecord}
        />
      )}
    </div>
  );
}
