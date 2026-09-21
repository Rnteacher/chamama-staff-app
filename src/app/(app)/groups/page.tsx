import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "קבוצות" };

export default async function GroupsPage() {
  await requireMe();
  const supabase = await createClient();

  const [groupsRes, studentsRes, mentorsRes, countsRes] = await Promise.all([
    supabase.from("greenhouse_groups").select("id, name").order("name"),
    supabase
      .from("students")
      .select("id, group_id, greenhouse_groups(name)")
      .eq("is_archived", false),
    supabase
      .from("group_mentors")
      .select("group_id, profiles(full_name)"),
    supabase.rpc("student_unread_counts"),
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

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">קבוצות החממה</h1>
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
    </div>
  );
}
