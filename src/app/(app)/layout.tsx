import Image from "next/image";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import PushBanner from "@/components/PushBanner";
import ViewAsBanner from "@/components/view-as/ViewAsBanner";
import { requireMe } from "@/lib/auth";
import { getViewAsState } from "@/lib/view-as";
import { createClient } from "@/lib/supabase/server";
import { APP_NAME } from "@/lib/constants";

// Personalized, session-bound pages: never statically prerender.
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: LayoutProps<"/">) {
  const me = await requireMe();
  const supabase = await createClient();

  // Total unread across everything the user may read (RLS-filtered RPC).
  const { data: unreadRows } = await supabase.rpc("student_unread_counts");
  const totalUnread = (
    (unreadRows ?? []) as Array<{ student_id: string; unread_count: number }>
  ).reduce((sum, r) => sum + Number(r.unread_count), 0);

  const isAdmin =
    me.roles.includes("super_admin") || me.roles.includes("project_coordinator");
  const viewAs = await getViewAsState();

  return (
    <div className="flex min-h-dvh flex-col">
      <ServiceWorkerRegister />
      {viewAs.active && (
        <ViewAsBanner staffName={viewAs.staffName ?? ""} roleContext={viewAs.roleContext ?? ""} />
      )}
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
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
            {isAdmin && (
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
              הפרופיל שלי
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-4">
        {children}
      </main>

      <PushBanner />
      <BottomNav totalUnread={totalUnread} />
    </div>
  );
}
