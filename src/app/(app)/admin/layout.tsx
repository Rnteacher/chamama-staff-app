import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";

export const metadata = { title: "ניהול" };

const tabs = [
  { href: "/admin", label: "סקירה", superOnly: false, employmentOnly: false },
  { href: "/admin/intake", label: "קבלת פרויקטים", superOnly: false, employmentOnly: false },
  { href: "/admin/forms", label: "טפסים", superOnly: false, employmentOnly: false },
  { href: "/admin/learning-groups", label: "קבוצות למידה", superOnly: false, employmentOnly: false },
  { href: "/admin/employment", label: "תעסוקה", superOnly: false, employmentOnly: true },
  { href: "/admin/staff", label: "סגל", superOnly: true, employmentOnly: false },
  { href: "/admin/students", label: "חניכים", superOnly: true, employmentOnly: false },
  { href: "/admin/groups", label: "קבוצות", superOnly: true, employmentOnly: false },
  { href: "/admin/majors", label: "מגמות", superOnly: true, employmentOnly: false },
  { href: "/admin/settings", label: "הגדרות", superOnly: true, employmentOnly: false },
];

export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  // the admin shell is open to super_admin, project coordinator, leadership
  // and employment coordinator; every individual page enforces its own
  // stricter requirement.
  const me = await requireMe();
  const isSuper = hasRole(me, "super_admin");
  const isCoordinator = hasRole(me, "project_coordinator");
  const canManageEmployment =
    hasRole(me, "employment_coordinator") || hasRole(me, "leadership") || isSuper;
  if (!isSuper && !isCoordinator && !canManageEmployment) {
    redirect("/?error=אין%20הרשאת%20מנהל");
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">ניהול המערכת</h1>
      <nav aria-label="תפריט ניהול">
        <ul className="flex flex-wrap gap-2">
          {tabs
            .filter((t) =>
              t.superOnly
                ? isSuper
                : t.employmentOnly
                  ? canManageEmployment
                  : isSuper || isCoordinator
            )
            .map((t) => (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className="block rounded-full border border-line bg-surface px-4 py-2 text-sm font-bold hover:bg-brand-soft/40"
                >
                  {t.label}
                </Link>
              </li>
            ))}
        </ul>
      </nav>
      {children}
    </div>
  );
}
