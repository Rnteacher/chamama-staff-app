import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getUnreadCounts } from "@/lib/unread";
import StudentRow, { type StudentRowData } from "@/components/StudentRow";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "מגמה" };

export default async function MajorPage({
  params,
}: PageProps<"/majors/[id]">) {
  const [{ id }, supabase] = await Promise.all([params, createClient()]);

  // RLS-scoped reads start together with the shared identity check (one
  // round trip); nothing is rendered before requireMe() has passed.
  const [, majorRes, headsRes, studentsRes, unreadByStudent] = await Promise.all([
    requireMe(),
    supabase.from("majors").select("id, name").eq("id", id).maybeSingle(),
    supabase.from("major_heads").select("profiles(id, full_name)").eq("major_id", id),
    supabase
      .from("students")
      .select("id, first_name, last_name, greenhouse_groups(name)")
      .eq("major_id", id)
      .eq("is_archived", false)
      .order("first_name"),
    getUnreadCounts(),
  ]);

  const major = majorRes.data;
  if (!major) notFound();


  const students: StudentRowData[] = (studentsRes.data ?? []).map((s) => {
    const row = s as unknown as {
      id: string;
      first_name: string;
      last_name: string;
      greenhouse_groups: { name: string } | null;
    };
    return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      groupName: row.greenhouse_groups?.name ?? null,
      unread: unreadByStudent.get(row.id) ?? 0,
    };
  });

  const heads = (headsRes.data ?? [])
    .map((h) => (h as unknown as { profiles: { full_name: string | null } | null }).profiles?.full_name)
    .filter((n): n is string => Boolean(n));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-extrabold">{major.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {heads.length > 0 ? `ראשי מגמה: ${heads.join(", ")}` : "אין ראשי מגמה מוגדרים"}
        </p>
      </header>

      {students.length === 0 ? (
        <EmptyState title="אין חניכים במגמה" description="טרם שויכו חניכים למגמה זו." />
      ) : (
        <ul className="flex flex-col gap-2 lg:grid lg:grid-cols-2">
          {students.map((s) => (
            <StudentRow key={s.id} student={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
