import { createClient } from "@/lib/supabase/server";
import {
  createStaffAction,
  updateStaffAction,
  setUserRolesAction,
  importStaffCsvAction,
} from "@/lib/actions/admin";
import { ALL_ROLES } from "@/lib/permissions";
import { ROLE_LABELS } from "@/lib/constants";
import AdminActionForm from "@/components/admin/AdminActionForm";
import AdminCsvImport from "@/components/admin/AdminCsvImport";
import type { Role } from "@/lib/permissions";

export const metadata = { title: "ניהול · סגל" };

export default async function AdminStaffPage() {
  const supabase = await createClient();
  const [staffRes, rolesRes, mentorsRes, mastersRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email, full_name, is_active, auth_user_id, created_at")
      .order("created_at", { ascending: true }),
    supabase.from("user_roles").select("staff_id, role"),
    supabase
      .from("group_mentors")
      .select("staff_id, greenhouse_groups(name)"),
    supabase.from("master_assignments").select("staff_id"),
  ]);

  const rolesByStaff = new Map<string, string[]>();
  for (const r of rolesRes.data ?? []) {
    rolesByStaff.set(r.staff_id, [
      ...(rolesByStaff.get(r.staff_id) ?? []),
      r.role,
    ]);
  }

  const groupsByStaff = new Map<string, string[]>();
  for (const m of mentorsRes.data ?? []) {
    const row = m as unknown as {
      staff_id: string;
      greenhouse_groups: { name: string } | null;
    };
    const name = row.greenhouse_groups?.name;
    if (!name) continue;
    groupsByStaff.set(row.staff_id, [
      ...(groupsByStaff.get(row.staff_id) ?? []),
      name,
    ]);
  }

  const masterCountByStaff = new Map<string, number>();
  for (const m of mastersRes.data ?? []) {
    masterCountByStaff.set(
      m.staff_id,
      (masterCountByStaff.get(m.staff_id) ?? 0) + 1
    );
  }

  const staff = staffRes.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">הוספת איש סגל</h2>
        <p className="mt-1 text-sm text-muted">
          איש הסגל נוצר מיד עם מזהה קבוע — ניתן לשייך אותו לתפקידים, קבוצות
          וחניכים עוד לפני שהתחבר פעם ראשונה. בכניסה הראשונה חשבון ה-Google
          מקושר אוטומטית לזהות הקיימת.
        </p>
        <AdminActionForm
          action={createStaffAction}
          submitLabel="הוספה"
          className="mt-3 flex flex-col gap-2"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-sm">
              אימייל
              <input
                name="email"
                type="email"
                required
                dir="ltr"
                className="mt-1 w-full rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="text-sm">
              שם מלא
              <input
                name="fullName"
                className="mt-1 w-full rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked
                className="h-5 w-5 accent-[#46b800]"
              />
              פעיל (רשאי להתחבר)
            </label>
          </div>
          <fieldset className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {ALL_ROLES.map((role) => (
              <label key={role} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="roles"
                  value={role}
                  className="h-5 w-5 accent-[#46b800]"
                />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </fieldset>
        </AdminActionForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-extrabold">ספר הצוות ({staff.length})</h2>
        {staff.map((s) => {
          const roles = rolesByStaff.get(s.id) ?? [];
          const linked = Boolean(s.auth_user_id);
          const groups = groupsByStaff.get(s.id) ?? [];
          const masterCount = masterCountByStaff.get(s.id) ?? 0;
          return (
            <article
              key={s.id}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold">{s.full_name ?? "—"}</p>
                  <p dir="ltr" className="text-sm text-muted">
                    {s.email}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {s.is_active ? (
                    <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-bold">
                      פעיל
                    </span>
                  ) : (
                    <span className="rounded-full border border-warn px-2.5 py-1 text-xs font-bold text-warn">
                      מושבית
                    </span>
                  )}
                  {linked ? (
                    <span className="rounded-full bg-bg px-2.5 py-1 text-xs font-bold text-muted">
                      מחובר/ת
                    </span>
                  ) : (
                    <span className="rounded-full border border-line px-2.5 py-1 text-xs font-bold text-muted">
                      טרם התחבר/ה
                    </span>
                  )}
                </div>
              </div>

              <p className="mt-2 flex flex-wrap gap-1">
                {roles.length === 0 ? (
                  <span className="text-xs text-muted">אין תפקידים</span>
                ) : (
                  roles.map((r) => (
                    <span
                      key={r}
                      className="rounded-full bg-bg px-2 py-0.5 text-xs font-semibold"
                    >
                      {ROLE_LABELS[r as Role] ?? r}
                    </span>
                  ))
                )}
              </p>
              {(groups.length > 0 || masterCount > 0) && (
                <p className="mt-1 text-xs text-muted">
                  {groups.length > 0 && `מנטור/ית בקבוצות: ${groups.join(", ")}`}
                  {groups.length > 0 && masterCount > 0 && " · "}
                  {masterCount > 0 && `מאסטר/ית של ${masterCount} חניכים`}
                </p>
              )}

              <div className="mt-3 flex flex-col gap-2">
                <details>
                  <summary className="cursor-pointer text-sm font-bold">
                    תפקידים
                  </summary>
                  <AdminActionForm
                    action={setUserRolesAction}
                    submitLabel="שמירת תפקידים"
                    className="mt-2"
                  >
                    <input type="hidden" name="staffId" value={s.id} />
                    <fieldset className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      {ALL_ROLES.map((role) => (
                        <label
                          key={role}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            name="roles"
                            value={role}
                            defaultChecked={roles.includes(role)}
                            className="h-5 w-5 accent-[#46b800]"
                          />
                          {ROLE_LABELS[role]}
                        </label>
                      ))}
                    </fieldset>
                  </AdminActionForm>
                </details>

                <details>
                  <summary className="cursor-pointer text-sm font-bold">
                    עריכה
                  </summary>
                  <AdminActionForm
                    action={updateStaffAction}
                    submitLabel="שמירה"
                    className="mt-2 flex flex-col gap-2"
                  >
                    <input type="hidden" name="id" value={s.id} />
                    <label className="text-sm">
                      שם מלא
                      <input
                        name="fullName"
                        defaultValue={s.full_name ?? ""}
                        className="mt-1 w-full rounded-xl border border-line px-3 py-2"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="isActive"
                        defaultChecked={s.is_active}
                        className="h-5 w-5 accent-[#46b800]"
                      />
                      פעיל (רשאי להתחבר)
                    </label>
                  </AdminActionForm>
                </details>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">ייבוא סגל מקובץ CSV</h2>
        <p className="mt-1 text-sm text-muted">
          עמודות: <code dir="ltr">email</code>, <code dir="ltr">full_name</code>{" "}
          (אופציונלי). שורה ראשונה = כותרות. אנשי סגל קיימים לא מושפעים.
        </p>
        <AdminCsvImport action={importStaffCsvAction} />
      </section>
    </div>
  );
}
