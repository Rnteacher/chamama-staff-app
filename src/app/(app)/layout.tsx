import Image from "next/image";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import PushBanner from "@/components/PushBanner";
import ViewAsBanner from "@/components/view-as/ViewAsBanner";
import { requireMe, canAccessManagement } from "@/lib/auth";
import type { Role } from "@/lib/permissions";
import { getViewAsState } from "@/lib/view-as";
import { createClient } from "@/lib/supabase/server";
import { getUnreadCounts, totalUnread as sumUnread } from "@/lib/unread";
import { APP_NAME } from "@/lib/constants";

// Personalized, session-bound pages: never statically prerender.
export const dynamic = "force-dynamic";

/**
 * Roles of the person whose read-experience is being rendered: the real
 * user, or the View-As simulated person (mapped from the role context).
 * Navigation shows what THIS person may see — never the viewer's own powers.
 */
function effectiveRoles(
  me: { roles: Role[] },
  viewAs: { active: boolean; roleContext: string | null }
): Role[] {
  if (!viewAs.active) return me.roles;
  switch (viewAs.roleContext) {
    case "project_coordinator":
      return ["project_coordinator"];
    case "mentor":
      return ["mentor"];
    case "master":
      return ["master"];
    case "major_head":
      return ["major_head"];
    default:
      return []; // ordinary staff — no role-derived nav powers
  }
}

export default async function AppLayout({
  children,
}: LayoutProps<"/">) {
  // Total unread across everything the user may read (RLS-filtered RPC,
  // shared with the page). It depends only on the session, so it runs
  // concurrently with the identity check instead of after it.
  const unreadP = getUnreadCounts();
  const [me, viewAs] = await Promise.all([requireMe(), getViewAsState()]);
  const roles = effectiveRoles(me, viewAs);

  // Management ("ניהול") appears only when the current person owns at least
  // one management capability — never merely for being staff. Each admin
  // sub-route keeps enforcing its own narrower authorization.
  const canManage = canAccessManagement(roles);

  // The full management calendar stays leadership/super_admin-only (route
  // guard re-checks); ordinary staff consume events through "היום שלי".
  const isCalendarAdmin =
    roles.includes("leadership") || roles.includes("super_admin");

  // Attendance entry (top-level, never hidden inside Admin):
  //   leadership/super_admin → the school-wide overview;
  //   home-group mentors → today's operational attendance for their group(s).
  // The real user's canonical mentor relationships arrive with the identity;
  // only a View-As simulation needs the simulated person's looked up.
  const isAttendanceAdmin = isCalendarAdmin;
  const mentorsCount = isAttendanceAdmin
    ? 0
    : viewAs.active
      ? viewAs.staffId
        ? (
            await (await createClient())
              .from("group_mentors")
              .select("group_id", { count: "exact", head: true })
              .eq("staff_id", viewAs.staffId)
          ).count ?? 0
        : 0
      : me.mentorGroupIds.length;
  const attendanceHref = isAttendanceAdmin ? "/attendance/overview" : "/attendance";
  const showAttendanceNav = isAttendanceAdmin || mentorsCount > 0;
  const totalUnread = sumUnread(await unreadP);

  return (
    <div className="flex min-h-dvh flex-col">
      <ServiceWorkerRegister />
      {viewAs.active && (
        <ViewAsBanner staffName={viewAs.staffName ?? ""} roleContext={viewAs.roleContext ?? ""} />
      )}
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center justify-between px-4 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5" aria-label={APP_NAME}>
            <Image
              src="/logo.png"
              alt=""
              width={34}
              height={34}
              className="object-contain"
              priority
            />
            <span className="text-lg font-extrabold tracking-tight">
              {APP_NAME}
            </span>
          </Link>
          <nav className="flex items-center gap-1 text-sm" aria-label="תפריט עליון">
            {showAttendanceNav && (
              <Link
                href={attendanceHref}
                className="rounded-full px-3 py-1.5 font-bold text-ink hover:bg-brand-soft/60"
              >
                נוכחות
              </Link>
            )}
            {canManage && (
              <Link
                href="/admin"
                className="rounded-full px-3 py-1.5 font-medium text-muted hover:bg-bg"
              >
                ניהול
              </Link>
            )}
            <Link
              href="/settings"
              className="rounded-full px-3 py-1.5 font-medium text-muted hover:bg-bg"
            >
              הגדרות
            </Link>
          </nav>
        </div>
      </header>

      {/* Desktop: a wide application canvas (not a phone column). Mobile:
          unchanged narrow flow with bottom-nav clearance. */}
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-28 pt-4 lg:px-8 lg:pt-6">
        {children}
      </main>

      <PushBanner staffId={me.staffId} />
      <BottomNav totalUnread={totalUnread} showCalendar={isCalendarAdmin} />
    </div>
  );
}
