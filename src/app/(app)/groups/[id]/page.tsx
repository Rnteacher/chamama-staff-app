import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import StudentRow, { type StudentRowData } from "@/components/StudentRow";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "קבוצה" };

export default async function GroupPage({
  params,
}: PageProps<"/groups/[id]">) {
  await requireMe();
  const { id } = await params;
  const supabase = await createClient();

  const [groupRes, mentorsRes, studentsRes, countsRes] = await Promise.all([
    supabase.from("greenhouse_groups").select("id, name").eq("id", id).maybeSingle(),
    supabase
      .from("group_mentors")
      .select("profiles(id, full_name)")
      .eq("group_id", id),
    supabase
      .from("students")
      .select("id, first_name, last_name, majors(name)")
      .eq("group_id", id)
      .eq("is_archived", false)
      .order("first_name"),
    supabase.rpc("student_unread_counts"),
  ]);

  const group = groupRes.data;
  if (!group) notFound();

  const unreadByStudent = new Map<string, number>();
  for (const row of countsRes.data ?? []) {
    unreadByStudent.set(row.student_id, Number(row.unread_count));
  }

  const students: StudentRowData[] = (studentsRes.data ?? []).map((s) => {
    const row = s as unknown as {
      id: string;
      first_name: string;
      last_name: string;
      majors: { name: string } | null;
    };
    return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      majorName: row.majors?.name ?? null,
      unread: unreadByStudent.get(row.id) ?? 0,
    };
  });

  const mentors = (mentorsRes.data ?? [])
    .map((m) => (m as unknown as { profiles: { full_name: string | null } | null }).profiles?.full_name)
    .filter((n): n is string => Boolean(n));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-extrabold">{group.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {mentors.length > 0 ? `מנטורים: ${mentors.join(", ")}` : "אין מנטורים מוגדרים"}
        </p>
      </header>

      {students.length === 0 ? (
        <EmptyState title="הקבוצה ריקה" description="אין חניכים פעילים בקבוצה זו." />
      ) : (
        <ul className="flex flex-col gap-2">
          {students.map((s) => (
            <StudentRow key={s.id} student={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
