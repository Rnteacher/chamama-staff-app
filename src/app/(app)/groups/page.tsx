import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import EmptyState from "@/components/EmptyState";
import { formatWeeklySlotsHe, normalizeTime, type WeeklySlot } from "@/lib/schedule";

export const metadata = { title: "קבוצות" };

interface LearningGroupRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  slots: WeeklySlot[];
  staffLeaderNames: string[];
  studentLeaderNames: string[];
  memberCount: number;
}

export default async function GroupsPage() {
  await requireMe();
  const supabase = await createClient();

  const [
    groupsRes,
    studentsRes,
    mentorsRes,
    countsRes,
    lgRes,
    lgSlotsRes,
    lgStaffRes,
    lgStudentRes,
    lgMembersRes,
  ] = await Promise.all([
    supabase.from("greenhouse_groups").select("id, name").order("name"),
    supabase
      .from("students")
      .select("id, group_id, greenhouse_groups(name)")
      .eq("is_archived", false),
    supabase
      .from("group_mentors")
      .select("group_id, profiles(full_name)"),
    supabase.rpc("student_unread_counts"),
    supabase
      .from("learning_groups")
      .select("id, name, description, is_active")
      .order("name"),
    supabase
      .from("learning_group_weekly_slots")
      .select("learning_group_id, weekday, start_time, end_time"),
    supabase
      .from("learning_group_staff_leaders")
      .select("learning_group_id, profiles(full_name)"),
    supabase
      .from("learning_group_student_leaders")
      .select("learning_group_id, students(first_name, last_name)"),
    supabase
      .from("learning_group_memberships")
      .select("learning_group_id")
      .is("ended_at", null),
  ]);

  const unreadByStudent = new Map<string, number>();
  for (const row of countsRes.data ?? []) {
    unreadByStudent.set(row.student_id, Number(row.unread_count));
  }

  const unreadByGroup = new Map<string, number>();
  for (const s of studentsRes.data ?? []) {
    const row = s as unknown as { id: string; group_id: string | null };
    if (!row.group_id) continue;
    unreadByGroup.set(
      row.group_id,
      (unreadByGroup.get(row.group_id) ?? 0) + (unreadByStudent.get(row.id) ?? 0)
    );
  }

  const mentorsByGroup = new Map<string, string[]>();
  for (const m of mentorsRes.data ?? []) {
    const row = m as unknown as {
      group_id: string;
      profiles: { full_name: string | null } | null;
    };
    const name = row.profiles?.full_name;
    if (!name) continue;
    mentorsByGroup.set(row.group_id, [
      ...(mentorsByGroup.get(row.group_id) ?? []),
      name,
    ]);
  }

  const groups = groupsRes.data ?? [];

  // ------------------------------------------------ learning groups data ---
  const staffByGroup = new Map<string, string[]>();
  for (const l of lgStaffRes.data ?? []) {
    const row = l as unknown as {
      learning_group_id: string;
      profiles: { full_name: string | null } | null;
    };
    const name = row.profiles?.full_name;
    if (!name) continue;
    staffByGroup.set(row.learning_group_id, [
      ...(staffByGroup.get(row.learning_group_id) ?? []),
      name,
    ]);
  }

  const studentLeadersByGroup = new Map<string, string[]>();
  for (const l of lgStudentRes.data ?? []) {
    const row = l as unknown as {
      learning_group_id: string;
      students: { first_name: string; last_name: string } | null;
    };
    const s = row.students;
    if (!s) continue;
    studentLeadersByGroup.set(row.learning_group_id, [
      ...(studentLeadersByGroup.get(row.learning_group_id) ?? []),
      `${s.first_name} ${s.last_name}`,
    ]);
  }

  const slotsByGroup = new Map<string, WeeklySlot[]>();
  for (const s of lgSlotsRes.data ?? []) {
    const row = s as unknown as {
      learning_group_id: string;
      weekday: number;
      start_time: string;
      end_time: string;
    };
    slotsByGroup.set(row.learning_group_id, [
      ...(slotsByGroup.get(row.learning_group_id) ?? []),
      { weekday: row.weekday, startTime: normalizeTime(row.start_time), endTime: normalizeTime(row.end_time) },
    ]);
  }

  const membersByGroup = new Map<string, number>();
  for (const m of lgMembersRes.data ?? []) {
    const row = m as unknown as { learning_group_id: string };
    membersByGroup.set(
      row.learning_group_id,
      (membersByGroup.get(row.learning_group_id) ?? 0) + 1
    );
  }

  const learningGroups: LearningGroupRow[] = (lgRes.data ?? []).map((g) => {
    const row = g as unknown as {
      id: string;
      name: string;
      description: string | null;
      is_active: boolean;
    };
    return {
      ...row,
      slots: slotsByGroup.get(row.id) ?? [],
      staffLeaderNames: staffByGroup.get(row.id) ?? [],
      studentLeaderNames: studentLeadersByGroup.get(row.id) ?? [],
      memberCount: membersByGroup.get(row.id) ?? 0,
    };
  });

  return (
    <div className="flex flex-col gap-8">
      {/* ------------------------------------------------ קבוצות אם ------- */}
      <section aria-labelledby="greenhouse-groups-heading" className="flex flex-col gap-4">
        <h1 id="greenhouse-groups-heading" className="text-xl font-extrabold">
          קבוצות אם
        </h1>
        {groups.length === 0 ? (
          <EmptyState title="אין קבוצות" description="טרם הוגדרו קבוצות במערכת." />
        ) : (
          <ul className="flex flex-col gap-2 lg:grid lg:grid-cols-2">
            {groups.map((g) => {
              const unread = unreadByGroup.get(g.id) ?? 0;
              const mentors = mentorsByGroup.get(g.id) ?? [];
              return (
                <li key={g.id}>
                  <Link
                    href={`/groups/${g.id}`}
                    className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold">{g.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {mentors.length > 0
                          ? `מנטורים: ${mentors.join(", ")}`
                          : "אין מנטורים מוגדרים"}
                      </span>
                    </span>
                    {unread > 0 && (
                      <span className="rounded-full bg-brand px-2.5 py-1 text-xs font-extrabold text-ink">
                        {unread}
                      </span>
                    )}
                    <span aria-hidden="true" className="text-muted">‹</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ------------------------------------------- קבוצות למידה --------- */}
      <section aria-labelledby="learning-groups-heading" className="flex flex-col gap-4">
        <h2 id="learning-groups-heading" className="text-xl font-extrabold">
          קבוצות למידה
        </h2>
        {learningGroups.length === 0 ? (
          <EmptyState
            title="אין קבוצות למידה"
            description="טרם הוגדרו קבוצות למידה. הנהלה יכולה להוסיף באזור הניהול."
          />
        ) : (
          <ul className="flex flex-col gap-2 lg:grid lg:grid-cols-2">
            {learningGroups.map((g) => (
              <li key={g.id}>
                <Link
                  href={`/groups/learning/${g.id}`}
                  className={`flex min-h-[68px] items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40 ${
                    g.is_active ? "" : "opacity-60"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{g.name}</span>
                      {!g.is_active && (
                        <span className="rounded-full bg-line px-2 py-0.5 text-[11px] font-bold text-muted">
                          לא פעילה
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted" dir="rtl">
                      {g.slots.length > 0
                        ? formatWeeklySlotsHe(g.slots)
                        : "אין מפגשים שבועיים מוגדרים"}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {[
                        g.staffLeaderNames.length > 0
                          ? `מדריכים: ${g.staffLeaderNames.join(", ")}`
                          : null,
                        g.studentLeaderNames.length > 0
                          ? `מובילים: ${g.studentLeaderNames.join(", ")}`
                          : null,
                        `${g.memberCount} חניכים`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-muted">‹</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
