import Link from "next/link";
import { requireMe } from "@/lib/auth";import { createClient } from "@/lib/supabase/server";
import { hasVapidConfig, hasAdminConfig } from "@/lib/server-env";

export const metadata = { title: "ניהול · סקירה" };

export default async function AdminOverviewPage() {
  await requireMe(); // overview is open to coordinators too
  const supabase = await createClient();
  const [staffRes, studentsRes, groupsRes, majorsRes] =
    await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("students").select("id", { count: "exact", head: true }),
      supabase.from("greenhouse_groups").select("id", { count: "exact", head: true }),
      supabase.from("majors").select("id", { count: "exact", head: true }),
    ]);

  const stats = [
    { label: "אנשי סגל בספר", value: staffRes.count ?? 0, href: "/admin/staff" },
    { label: "חניכים", value: studentsRes.count ?? 0, href: "/admin/students" },
    { label: "קבוצות", value: groupsRes.count ?? 0, href: "/admin/groups" },
    { label: "מגמות", value: majorsRes.count ?? 0, href: "/admin/majors" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              className="block rounded-2xl border border-line bg-surface p-4 hover:bg-brand-soft/40"
            >
              <span className="block text-2xl font-extrabold">{s.value}</span>
              <span className="text-sm text-muted">{s.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <section className="rounded-2xl border border-line bg-surface p-4 text-sm leading-6">
        <h2 className="font-extrabold">מצב התצורה</h2>
        <ul className="mt-1 space-y-1">
          <li>
            מפתח שירות (ניהול/התראות):{" "}
            <Status on={hasAdminConfig()} />
          </li>
          <li>
            מפתחות VAPID (התראות דחיפה):{" "}
            <Status on={hasVapidConfig()} />
          </li>
        </ul>
        <p className="mt-2 text-muted">
          יומן הביקורת נשמר במסד הנתונים ואינו חשוף לקריאה דרך הממשק.
        </p>
      </section>
    </div>
  );
}

function Status({ on }: { on: boolean }) {
  return on ? (
    <strong className="text-brand-dark">מוגדר</strong>
  ) : (
    <strong className="text-warn">לא הוגדר</strong>
  );
}
