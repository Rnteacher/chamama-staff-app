import { notFound } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";
import { getViewAsState } from "@/lib/view-as";
import { createClient } from "@/lib/supabase/server";
import EmptyState from "@/components/EmptyState";
import Link from "next/link";
import {
  LearningGroupMemberPicker,
  LearningGroupMemberRemoveButton,
} from "@/components/learning-groups/LearningGroupMemberPicker";
import { formatWeeklySlotsHe, normalizeTime, type WeeklySlot } from "@/lib/schedule";
import { isoDate } from "@/lib/schedule";
import { jerusalemParts } from "@/lib/meetings";

export const metadata = { title: "קבוצת למידה" };

export default async function LearningGroupPage({
  params,
}: PageProps<"/groups/learning/[id]">) {
  const [{ id }, supabase] = await Promise.all([params, createClient()]);

  // RLS-scoped reads start together with the shared identity check (one
  // round trip); nothing is rendered before requireMe() has passed.
  const [me, groupRes, slotsRes, staffRes, studentRes, membersRes, allStudentsRes] =
    await Promise.all([
      requireMe(),
      supabase
        .from("learning_groups")
        .select("id, name, description, is_active")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("learning_group_weekly_slots")
        .select("weekday, start_time, end_time")
        .eq("learning_group_id", id),
      supabase
        .from("learning_group_staff_leaders")
        .select("staff_id, profiles(full_name)")
        .eq("learning_group_id", id),
      supabase
        .from("learning_group_student_leaders")
        .select("student_id, students(first_name, last_name)")
        .eq("learning_group_id", id),
      supabase
        .from("learning_group_memberships")
        .select("student_id, joined_at, students(first_name, last_name)")
        .eq("learning_group_id", id)
        .is("ended_at", null)
        .order("joined_at"),
      supabase
        .from("students")
        .select("id, first_name, last_name")
        .eq("is_archived", false)
        .order("first_name"),
    ]);

  const group = groupRes.data as unknown as {
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
  } | null;
  if (!group) notFound();

  const slots: WeeklySlot[] = (slotsRes.data ?? []).map((s) => {
    const row = s as unknown as {
      weekday: number;
      start_time: string;
      end_time: string;
    };
    return { weekday: row.weekday, startTime: normalizeTime(row.start_time), endTime: normalizeTime(row.end_time) };
  });

  const jp = jerusalemParts(new Date());
  const todayISO = isoDate(jp.year, jp.month, jp.day);

  const staffLeaders = (staffRes.data ?? [])
    .map((l) => {
      const row = l as unknown as {
        staff_id: string;
        profiles: { full_name: string | null } | null;
      };
      return { id: row.staff_id, name: row.profiles?.full_name ?? row.staff_id };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const studentLeaders = (studentRes.data ?? [])
    .map((l) => {
      const row = l as unknown as {
        student_id: string;
        students: { first_name: string; last_name: string } | null;
      };
      return row.students
        ? {
            id: row.student_id,
            name: `${row.students.first_name} ${row.students.last_name}`,
          }
        : null;
    })
    .filter((x): x is { id: string; name: string } => Boolean(x));

  const members = (membersRes.data ?? [])
    .map((m) => {
      const row = m as unknown as {
        student_id: string;
        students: { first_name: string; last_name: string } | null;
      };
      return row.students
        ? {
            id: row.student_id,
            name: `${row.students.first_name} ${row.students.last_name}`,
          }
        : null;
    })
    .filter((x): x is { id: string; name: string } => Boolean(x));

  const pickerStudents = (allStudentsRes.data ?? [])
    .map((s) => s as unknown as { id: string; first_name: string; last_name: string })
    .map((s) => ({ id: s.id, firstName: s.first_name, lastName: s.last_name }))
    .filter((s) => !members.some((m) => m.id === s.id));

  // UI hint only — the server RPC is the authorization boundary.
  const amStaffLeader = staffLeaders.some((l) => l.id === me.staffId);
  const viewAs = await getViewAsState();
  // View-As is strictly read-only: never render mutation controls.
  const canManage =
    !viewAs.active &&
    (amStaffLeader || hasRole(me, "leadership") || hasRole(me, "super_admin"));

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
      <section className="flex flex-1 flex-col gap-4">
        <header>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold">{group.name}</h1>
            {!group.is_active && (
              <span className="rounded-full bg-line px-2.5 py-1 text-xs font-bold text-muted">
                לא פעילה
              </span>
            )}
          </div>
          {group.description && (
            <p className="mt-1 text-sm text-muted">{group.description}</p>
          )}
          {/* direct attendance entry for the group's staff leaders */}
          {canManage && (
            <Link
              href={`/groups/learning/${group.id}/attendance?date=${todayISO}`}
              className="mt-3 inline-flex min-h-[44px] items-center rounded-full border-2 border-brand-dark bg-brand-soft px-5 font-extrabold text-ink hover:bg-brand-soft/70"
            >
              נוכחות
            </Link>
          )}
        </header>

        <div className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-sm font-bold">מפגשים שבועיים</h2>
          <p className="mt-1 text-sm text-muted">
            {slots.length > 0 ? formatWeeklySlotsHe(slots) : "אין מפגשים מוגדרים"}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-sm font-bold">מדריכים (צוות)</h2>
            {staffLeaders.length === 0 ? (
              <p className="mt-1 text-sm text-muted">אין</p>
            ) : (
              <ul className="mt-1 list-inside list-disc text-sm">
                {staffLeaders.map((l) => (
                  <li key={l.id}>{l.name}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-sm font-bold">מובילים (חניכים)</h2>
            {studentLeaders.length === 0 ? (
              <p className="mt-1 text-sm text-muted">אין</p>
            ) : (
              <ul className="mt-1 list-inside list-disc text-sm">
                {studentLeaders.map((l) => (
                  <li key={l.id}>{l.name}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-bold">
            חניכים בקבוצה ({members.length})
          </h2>
          {members.length === 0 ? (
            <EmptyState
              title="הקבוצה ריקה"
              description={
                canManage
                  ? "הוסיפו חניכים בעזרת החיפוש."
                  : "טרם נרשמו חניכים לקבוצה זו."
              }
            />
          ) : (
            <ul className="flex flex-col gap-2 lg:grid lg:grid-cols-2">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex min-h-[52px] items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-4 py-2.5"
                >
                  <span className="text-sm font-semibold">{m.name}</span>
                  {canManage && (
                    <LearningGroupMemberRemoveButton
                      groupId={group.id}
                      studentId={m.id}
                      studentName={m.name}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {canManage && (
        <aside className="w-full lg:w-96 lg:shrink-0">
          <LearningGroupMemberPicker groupId={group.id} students={pickerStudents} />
          <p className="mt-2 text-xs text-muted">
            ההוספה/הסרה משנה רק את הרשימה של קבוצת הלמידה — הקבוצה של החניך/ה
            אינה מושפעת.
          </p>
        </aside>
      )}
    </div>
  );
}
