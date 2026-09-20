import Link from "next/link";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { hasVapidConfig, hasAdminConfig } from "@/lib/server-env";
import ViewAsEntry, { type ViewAsStaffOption } from "@/components/view-as/ViewAsEntry";

export const metadata = { title: "ניהול · סקירה" };

export default async function AdminOverviewPage() {
  const me = await requireMe();
  const isSuper = hasRole(me, "super_admin");
  const supabase = await createClient();

  const [staffRes, studentsRes, groupsRes, majorsRes, mentorsRes, mastersRes, majorHeadsRes, rolesRes] =
    await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("students").select("id", { count: "exact", head: true }),
      supabase.from("greenhouse_groups").select("id", { count: "exact", head: true }),
      supabase.from("majors").select("id", { count: "exact", head: true }),
      supabase.from("group_mentors").select("staff_id"),
      supabase.from("master_assignments").select("staff_id"),
      supabase.from("major_heads").select("staff_id"),
      supabase.from("user_roles").select("staff_id, role").eq("role", "project_coordinator"),
    ]);

  const mentorIds = new Set((mentorsRes.data ?? []).map((m) => m.staff_id));
  const masterIds = new Set((mastersRes.data ?? []).map((m) => m.staff_id));
  const majorHeadIds = new Set((majorHeadsRes.data ?? []).map((m) => m.staff_id));
  const coordinatorIds = new Set((rolesRes.data ?? []).map((r) => r.staff_id));

  const activeStaff = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("is_active", true)
    .order("full_name");

  const viewAsStaff: ViewAsStaffOption[] = (activeStaff.data ?? []).map((p) => ({
    id: p.id,
    name: p.full_name ?? p.id,
    is_mentor: mentorIds.has(p.id),
    is_master: masterIds.has(p.id),
    is_major_head: majorHeadIds.has(p.id),
    is_project_coordinator: coordinatorIds.has(p.id),
  }));

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

      {isSuper && <ViewAsEntry staff={viewAsStaff} />}

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
