import Link from "next/link";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = { title: "ניהול · טפסים" };

export default async function AdminFormsPage() {
  const me = await requireMe();
  if (!hasRole(me, "super_admin") && !hasRole(me, "project_coordinator")) {
    redirect("/");
  }
  const supabase = await createClient();
  const [defsRes, countsRes] = await Promise.all([
    supabase
      .from("form_definitions")
      .select("id, form_key, name, description, audience, feed_category, status, current_version_id, archived_at, created_at, updated_at")
      .order("updated_at", { ascending: false }),
    supabase.from("form_submissions").select("form_definition_id"),
  ]);

  const submissionCounts = new Map<string, number>();
  for (const s of countsRes.data ?? []) {
    submissionCounts.set(
      s.form_definition_id,
      (submissionCounts.get(s.form_definition_id) ?? 0) + 1
    );
  }

  const forms = defsRes.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold">טפסים</h1>
        <Link
          href="/admin/forms/new"
          className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-white"
        >
          טופס חדש
        </Link>
      </div>

      {forms.length === 0 ? (
        <p className="text-sm text-muted">אין טפסים. צרו טופס חדש כדי להתחיל.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {forms.map((f) => {
            const statusChip =
              f.status === "published"
                ? "bg-brand-soft text-ink"
                : f.status === "archived"
                  ? "border-warn text-warn"
                  : "border-line text-muted";
            return (
              <li key={f.id} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Link href={`/admin/forms/${f.id}`} className="font-bold hover:underline">
                      {f.name}
                    </Link>
                    <span dir="ltr" className="mr-2 text-xs text-muted">{f.form_key}</span>
                    <p className="text-xs text-muted">
                      {f.audience === "public" ? "ציבורי" : "צוות"} · עודכן{" "}
                      {new Date(f.updated_at).toLocaleDateString("he-IL")} ·{" "}
                      {submissionCounts.get(f.id) ?? 0} הגשות
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${statusChip}`}>
                      {f.status === "published" ? "מפורסם" : f.status === "archived" ? "מאוכסן" : "טיוטה"}
                    </span>
                    {f.current_version_id && (
                      <span className="rounded-full bg-bg px-2 py-0.5 text-xs font-semibold text-muted">
                        גרסה {1}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
