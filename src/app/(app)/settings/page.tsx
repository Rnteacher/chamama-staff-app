import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/constants";
import { getViewAsState } from "@/lib/view-as";
import PushManager from "@/components/PushManager";
import SignOutButton from "@/components/SignOutButton";
import InstallHint from "@/components/InstallHint";

export const metadata = { title: "הגדרות" };

export default async function SettingsPage() {
  const me = await requireMe();
  const viewAs = await getViewAsState();
  // structural admin areas are super_admin-only routes — show them only to a
  // real super_admin (never to a simulated person)
  const isSuper = me.roles.includes("super_admin") && !viewAs.active;
  // functional roles only — the implicit base "staff" identity is not a chip
  const functionalRoles = me.roles.filter((r) => r !== "staff");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-extrabold">הגדרות</h1>

      <section aria-labelledby="profile-heading" className="rounded-2xl border border-line bg-surface p-4">
        <h2 id="profile-heading" className="font-extrabold">הפרופיל שלי</h2>
        <p className="mt-2 font-bold">{me.fullName ?? "ללא שם"}</p>
        <p dir="ltr" className="text-sm text-muted">
          {me.email}
        </p>
        {functionalRoles.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-1.5">
            {functionalRoles.map((r) => (
              <span
                key={r}
                className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-bold text-ink"
              >
                {ROLE_LABELS[r]}
              </span>
            ))}
          </p>
        )}
      </section>

      {isSuper && (
        <section aria-labelledby="admin-settings-heading" className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
          <h2 id="admin-settings-heading" className="font-extrabold">
            ניהול מערכת · מבנה החממה
          </h2>
          <ul className="flex flex-col divide-y divide-line">
            {[
              { href: "/admin/staff", label: "צוות" },
              { href: "/admin/students", label: "חניכים" },
              { href: "/admin/groups", label: "קבוצות" },
              { href: "/admin/majors", label: "מגמות" },
              { href: "/admin/settings", label: "הגדרות מערכת" },
            ].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex min-h-[48px] items-center justify-between px-1 py-2 text-sm font-bold hover:bg-brand-soft/40"
                >
                  {item.label}
                  <span aria-hidden="true" className="text-muted">‹</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="notif-heading" className="flex flex-col gap-3">
        <h2 id="notif-heading" className="font-extrabold">התראות</h2>
        <PushManager staffId={me.staffId} />
      </section>

      <InstallHint />

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <SignOutButton className="rounded-full border border-line bg-surface px-6 py-3 font-bold text-danger" />
      </section>
    </div>
  );
}
