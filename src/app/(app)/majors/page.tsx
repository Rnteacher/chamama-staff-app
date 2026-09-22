import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getUnreadCounts } from "@/lib/unread";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "מגמות" };

export default async function MajorsPage() {
  const supabase = await createClient();

  // RLS-scoped reads start together with the shared identity check (one
  // round trip); nothing is rendered before requireMe() has passed.
  const [, majorsRes, studentsRes, headsRes, unreadByStudent] = await Promise.all([
    requireMe(),
    supabase.from("majors").select("id, name").order("name"),
    supabase
      .from("students")
      .select("id, major_id")
      .eq("is_archived", false),
    supabase.from("major_heads").select("major_id, profiles(full_name)"),
    getUnreadCounts(),
  ]);

  const unreadByMajor = new Map<string, number>();
  for (const s of studentsRes.data ?? []) {
    if (!s.major_id) continue;
    unreadByMajor.set(
      s.major_id,
      (unreadByMajor.get(s.major_id) ?? 0) + (unreadByStudent.get(s.id) ?? 0)
    );
  }
  const headsByMajor = new Map<string, string[]>();
  for (const h of headsRes.data ?? []) {
    const row = h as unknown as {
      major_id: string;
      profiles: { full_name: string | null } | null;
    };
    const name = row.profiles?.full_name;
    if (!name) continue;
    headsByMajor.set(row.major_id, [
      ...(headsByMajor.get(row.major_id) ?? []),
      name,
    ]);
  }

  const majors = majorsRes.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">מגמות</h1>
      {majors.length === 0 ? (
        <EmptyState title="אין מגמות" description="טרם הוגדרו מגמות במערכת." />
      ) : (
        <ul className="flex flex-col gap-2 lg:grid lg:grid-cols-2">
          {majors.map((m) => {
            const unread = unreadByMajor.get(m.id) ?? 0;
            const heads = headsByMajor.get(m.id) ?? [];
            return (
              <li key={m.id}>
                <Link
                  href={`/majors/${m.id}`} prefetch={false}
                  className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-brand-soft/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold">{m.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {heads.length > 0
                        ? `ראשי מגמה: ${heads.join(", ")}`
                        : "אין ראשי מגמה מוגדרים"}
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
