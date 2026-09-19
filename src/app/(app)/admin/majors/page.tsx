import { requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  upsertMajorAction,
  setMajorHeadsAction,
} from "@/lib/actions/admin";
import AdminActionForm from "@/components/admin/AdminActionForm";

export const metadata = { title: "ניהול · מגמות" };

export default async function AdminMajorsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const [majorsRes, headsRes, profilesRes] = await Promise.all([
    supabase.from("majors").select("id, name").order("name"),
    supabase.from("major_heads").select("major_id, staff_id"),
    supabase
      .from("profiles")
      .select("id, email, full_name, auth_user_id")
      .eq("is_active", true)
      .order("full_name"),
  ]);

  const staff = profilesRes.data ?? [];
  const headsByMajor = new Map<string, string[]>();
  for (const h of headsRes.data ?? []) {
    headsByMajor.set(h.major_id, [...(headsByMajor.get(h.major_id) ?? []), h.staff_id]);
  }

  const majors = majorsRes.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">הוספת מגמה</h2>
        <AdminActionForm
          action={upsertMajorAction}
          submitLabel="הוספה"
          className="mt-3 flex gap-2"
        >
          <label className="flex-1 text-sm">
            שם המגמה
            <input name="name" required className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
        </AdminActionForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-extrabold">מגמות ({majors.length})</h2>
        {majors.map((m) => {
          const headIds = headsByMajor.get(m.id) ?? [];
          return (
            <article key={m.id} className="rounded-2xl border border-line bg-surface p-4">
              <p className="font-bold">{m.name}</p>
              <div className="mt-3 flex flex-col gap-2">
                <details>
                  <summary className="cursor-pointer text-sm font-bold">שינוי שם</summary>
                  <AdminActionForm action={upsertMajorAction} submitLabel="שמירה" className="mt-2 flex gap-2">
                    <input type="hidden" name="id" value={m.id} />
                    <label className="flex-1 text-sm">
                      שם המגמה
                      <input
                        name="name"
                        required
                        defaultValue={m.name}
                        className="mt-1 w-full rounded-xl border border-line px-3 py-2"
                      />
                    </label>
                  </AdminActionForm>
                </details>
                <details>
                  <summary className="cursor-pointer text-sm font-bold">
                    ראשי מגמה ({headIds.length})
                  </summary>
                  <AdminActionForm action={setMajorHeadsAction} submitLabel="שמירת ראשי מגמה" className="mt-2">
                    <input type="hidden" name="majorId" value={m.id} />
                    <fieldset className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {staff.map((p) => (
                        <label key={p.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="staffIds"
                            value={p.id}
                            defaultChecked={headIds.includes(p.id)}
                            className="h-5 w-5 accent-[#46b800]"
                          />
                          <span>
                            {p.full_name ?? p.email}
                            {p.auth_user_id === null && (
                              <span className="text-xs text-warn"> · טרם התחבר/ה</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  </AdminActionForm>
                </details>
              </div>
            </article>
          );
        })}
        {majors.length === 0 && <p className="text-sm text-muted">אין מגמות.</p>}
      </section>
    </div>
  );
}
