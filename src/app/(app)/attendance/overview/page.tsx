import Link from "next/link";
import { requireMe, hasRole } from "@/lib/auth";
import { jerusalemParts } from "@/lib/meetings";
import { isoDate } from "@/lib/schedule";
import { createClient } from "@/lib/supabase/server";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "נוכחות — סקירת הנהלה" };

interface OverviewRow {
  group_id: string;
  group_name: string;
  total: number;
  present: number;
  absent: number;
  late: number;
  working: number;
  unresolved: number;
  reported: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SCHOOL-WIDE / LEADERSHIP daily overview — operational and today-focused
 * (not analytics): one row per home group with the completion counts.
 * Click a group → its detailed attendance table. leadership / super_admin
 * only (enforced here AND inside the RPC).
 */
export default async function AttendanceOverviewPage({
  searchParams,
}: PageProps<"/attendance/overview">) {
  const me = await requireMe();
  if (!(hasRole(me, "leadership") || hasRole(me, "super_admin"))) {
    return (
      <EmptyState
        title="אין הרשאה"
        description="סקירת הנוכחות היומית זמינה להנהלה ולמנהל המערכת בלבד."
      />
    );
  }

  const sp = await searchParams;
  const jp = jerusalemParts(new Date());
  const today = isoDate(jp.year, jp.month, jp.day);
  const date = typeof sp.date === "string" && DATE_RE.test(sp.date) ? sp.date : today;

  const supabase = await createClient();
  const { data } = await supabase.rpc("school_attendance_overview", { p_date: date });
  const rows = (data ?? []) as unknown as OverviewRow[];

  const totals = rows.reduce(
    (acc, r) => ({
      total: acc.total + Number(r.total),
      present: acc.present + Number(r.present),
      absent: acc.absent + Number(r.absent),
      late: acc.late + Number(r.late),
      working: acc.working + Number(r.working),
      unresolved: acc.unresolved + Number(r.unresolved),
    }),
    { total: 0, present: 0, absent: 0, late: 0, working: 0, unresolved: 0 }
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold">נוכחות יומית — סקירה</h1>
          <p className="mt-1 text-sm text-muted">
            {totals.total} חניכים · {totals.present} נוכחים · {totals.absent} חסרים ·{" "}
            {totals.late} מאחרים · {totals.working} בעבודה · {totals.unresolved} טרם דווחו
          </p>
        </div>
        <form method="get" className="flex items-end gap-2">
          <label className="text-sm font-bold">
            תאריך
            <input
              type="date"
              name="date"
              defaultValue={date}
              className="mr-2 rounded-xl border border-line bg-surface px-3 py-2"
            />
          </label>
          <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm font-extrabold text-white">
            הצגה
          </button>
        </form>
      </header>

      {rows.length === 0 ? (
        <EmptyState title="אין קבוצות" description="טרם הוגדרו קבוצות." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line text-right text-xs text-muted">
                <th className="px-4 py-3 font-bold">קבוצה</th>
                <th className="px-4 py-3 font-bold">סה״כ</th>
                <th className="px-4 py-3 font-bold">דווחו</th>
                <th className="px-4 py-3 font-bold">נוכחים</th>
                <th className="px-4 py-3 font-bold">חסרים</th>
                <th className="px-4 py-3 font-bold">מאחרים</th>
                <th className="px-4 py-3 font-bold">בעבודה</th>
                <th className="px-4 py-3 font-bold">טרם דווחו</th>
                <th className="px-4 py-3 font-bold" aria-label="פעולות" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.group_id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-3 font-bold">{r.group_name}</td>
                  <td className="px-4 py-3">{r.total}</td>
                  <td className="px-4 py-3">{r.reported}</td>
                  <td className="px-4 py-3 font-bold text-emerald-800">{r.present}</td>
                  <td className="px-4 py-3 font-bold text-red-800">{r.absent}</td>
                  <td className="px-4 py-3 font-bold text-amber-800">{r.late}</td>
                  <td className="px-4 py-3 text-muted">{r.working}</td>
                  <td className="px-4 py-3 text-muted">{r.unresolved}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/attendance?group=${r.group_id}&date=${date}`} prefetch={false}
                      className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted hover:bg-bg"
                    >
                      פתיחה ›
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
