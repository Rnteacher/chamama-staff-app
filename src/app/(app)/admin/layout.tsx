import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata = { title: "ניהול" };

const tabs = [
  { href: "/admin", label: "סקירה" },
  { href: "/admin/staff", label: "סגל" },
  { href: "/admin/students", label: "חניכים" },
  { href: "/admin/groups", label: "קבוצות" },
  { href: "/admin/majors", label: "מגמות" },
  { href: "/admin/settings", label: "הגדרות" },
];

export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  await requireSuperAdmin(); // server-side guard, mirrored by every action
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">ניהול המערכת</h1>
      <nav aria-label="תפריט ניהול">
        <ul className="flex flex-wrap gap-2">
          {tabs.map((t) => (
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
