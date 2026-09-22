import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMe, hasRole, canAccessManagement } from "@/lib/auth";
import { getViewAsState } from "@/lib/view-as";

export const metadata = { title: "ניהול" };

/**
 * Operational management areas only. The structural admin data (צוות /
 * חניכים / קבוצות / מגמות) moved into הגדרות; the generic form builder is
 * frozen (routes stay intact for future reactivation but are not advertised).
 */
const tabs = [
  { href: "/admin", label: "סקירה", employmentOnly: false },
  { href: "/admin/intake", label: "הצהרת כוונות", employmentOnly: false },
  { href: "/admin/learning-groups", label: "קבוצות למידה", employmentOnly: false },
  { href: "/admin/employment", label: "תעסוקה", employmentOnly: true },
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
  if (!canAccessManagement(me.roles)) {
    redirect("/?error=אין%20הרשאת%20מנהל");
  }

  // View-As: the simulated person's read experience decides — a simulated
  // ordinary staff member never reaches the management shell (mutations are
  // blocked everywhere anyway). project_coordinator is a real management
  // context and keeps read access.
  const viewAs = await getViewAsState();
  if (viewAs.active && viewAs.roleContext !== "project_coordinator") {
    redirect("/?error=ניהול%20אינו%20זמין%20במצב%20צפייה");
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">ניהול</h1>
      <nav aria-label="תפריט ניהול">
        <ul className="flex flex-wrap gap-2">
          {tabs
            .filter((t) => (t.employmentOnly ? canManageEmployment : true))
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
