import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getUnreadCounts } from "@/lib/unread";
import SearchClient from "@/components/SearchClient";

export const metadata = { title: "חיפוש חניך" };

export default async function SearchPage() {
  const supabase = await createClient();

  // RLS-scoped reads start together with the shared identity check (one
  // round trip); nothing is rendered before requireMe() has passed.
  const [, studentsRes, unreadByStudent] = await Promise.all([
    requireMe(),
    supabase
      .from("students")
      .select("id, first_name, last_name, greenhouse_groups(name), majors(name)")
      .eq("is_archived", false)
      .order("first_name"),
    getUnreadCounts(),
  ]);

  const students = (studentsRes.data ?? []).map((s) => {
    const row = s as unknown as {
      id: string;
      first_name: string;
      last_name: string;
      greenhouse_groups: { name: string } | null;
      majors: { name: string } | null;
    };
    return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      groupName: row.greenhouse_groups?.name ?? null,
      majorName: row.majors?.name ?? null,
      unread: unreadByStudent.get(row.id) ?? 0,
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">חיפוש חניך</h1>
      <SearchClient students={students} />
    </div>
  );
}
