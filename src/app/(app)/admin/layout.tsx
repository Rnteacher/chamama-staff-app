import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";

export const metadata = { title: "ניהול" };

const tabs = [
  { href: "/admin", label: "סקירה", superOnly: false },
  { href: "/admin/intake", label: "קבלת פרויקטים", superOnly: false },
  { href: "/admin/staff", label: "סגל", superOnly: true },
  { href: "/admin/students", label: "חניכים", superOnly: true },
  { href: "/admin/groups", label: "קבוצות", superOnly: true },
  { href: "/admin/majors", label: "מגמות", superOnly: true },
  { href: "/admin/settings", label: "הגדרות", superOnly: true },
];

export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  // the admin shell is open to super_admin AND project coordinator;
  // every individual page enforces its own stricter requirement.
  const me = await requireMe();
  const isSuper = hasRole(me, "super_admin");
  const isCoordinator = hasRole(me, "project_coordinator");
  if (!isSuper && !isCoordinator) {
    redirect("/?error=אין%20הרשאת%20מנהל");
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">ניהול המערכת</h1>
      <nav aria-label="תפריט ניהול">
        <ul className="flex flex-wrap gap-2">
          {tabs
            .filter((t) => isSuper || !t.superOnly)
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
