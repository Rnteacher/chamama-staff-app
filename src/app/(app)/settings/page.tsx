import { requireMe } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/constants";
import PushManager from "@/components/PushManager";
import SignOutButton from "@/components/SignOutButton";
import InstallHint from "@/components/InstallHint";

export const metadata = { title: "הפרופיל שלי" };

export default async function SettingsPage() {
  const me = await requireMe();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-extrabold">הפרופיל שלי</h1>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <p className="font-bold">{me.fullName ?? "ללא שם"}</p>
        <p dir="ltr" className="text-sm text-muted">
          {me.email}
        </p>
        <p className="mt-2 flex flex-wrap gap-1.5">
          {me.roles.map((r) => (
            <span
              key={r}
              className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-bold text-ink"
            >
              {ROLE_LABELS[r]}
            </span>
          ))}
        </p>
      </section>

      <section aria-labelledby="notif-heading" className="flex flex-col gap-3">
        <h2 id="notif-heading" className="font-extrabold">התראות</h2>
        <PushManager />
      </section>

      <InstallHint />

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <SignOutButton className="rounded-full border border-line bg-surface px-6 py-3 font-bold text-danger" />
      </section>
    </div>
  );
}
