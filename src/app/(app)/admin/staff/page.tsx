import { createClient } from "@/lib/supabase/server";
import {
  upsertStaffEmailAction,
  setUserRolesAction,
  deleteStaffEmailAction,
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
  const [allowRes, profilesRes, rolesRes] = await Promise.all([
    supabase.from("allowed_staff_emails").select("*").order("email"),
    supabase.from("profiles").select("id, email, full_name, is_active"),
    supabase.from("user_roles").select("user_id, role"),
  ]);

  const profileByEmail = new Map(
    (profilesRes.data ?? []).map((p) => [p.email.toLowerCase(), p])
  );
  const rolesByUser = new Map<string, string[]>();
  for (const r of rolesRes.data ?? []) {
    rolesByUser.set(r.user_id, [...(rolesByUser.get(r.user_id) ?? []), r.role]);
  }

  const entries = allowRes.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">הוספת איש סגל</h2>
        <p className="mt-1 text-sm text-muted">
          כתובת ברשימה זו בלבד יכולה להיכנס למערכת (דרך Google).
        </p>
        <AdminActionForm
          action={upsertStaffEmailAction}
          submitLabel="הוספה"
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <label className="flex-1 text-sm">
            אימייל
            <input
              name="email"
              type="email"
              required
              dir="ltr"
              className="mt-1 w-full rounded-xl border border-line px-3 py-2"
            />
          </label>
          <label className="flex-1 text-sm">
            שם מלא
            <input
              name="fullName"
              className="mt-1 w-full rounded-xl border border-line px-3 py-2"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked className="h-5 w-5 accent-[#46b800]" />
            פעיל
          </label>
        </AdminActionForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-extrabold">אנשי סגל ({entries.length})</h2>
        {entries.map((e) => {
          const profile = profileByEmail.get(String(e.email).toLowerCase());
          const roles = profile ? rolesByUser.get(profile.id) ?? [] : [];
          return (
            <article
              key={e.id}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold">{e.full_name ?? "—"}</p>
                  <p dir="ltr" className="text-sm text-muted">
                    {e.email}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {e.is_active ? (
                    <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-bold">
                      פעיל
                    </span>
                  ) : (
                    <span className="rounded-full border border-warn px-2.5 py-1 text-xs font-bold text-warn">
                      מושבית
                    </span>
                  )}
                  {!profile && (
                    <span className="rounded-full border border-line px-2.5 py-1 text-xs font-bold text-muted">
                      טרם התחבר
                    </span>
                  )}
                </div>
              </div>

              {profile && (
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
              )}

              <div className="mt-3 flex flex-col gap-2">
                {profile && (
                  <details>
                    <summary className="cursor-pointer text-sm font-bold">
                      תפקידים
                    </summary>
                    <AdminActionForm
                      action={setUserRolesAction}
                      submitLabel="שמירת תפקידים"
                      className="mt-2"
                    >
                      <input type="hidden" name="userId" value={profile.id} />
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
                )}

                <details>
                  <summary className="cursor-pointer text-sm font-bold">
                    עריכה
                  </summary>
                  <AdminActionForm
                    action={upsertStaffEmailAction}
                    submitLabel="שמירה"
                    className="mt-2 flex flex-col gap-2"
                  >
                    <input type="hidden" name="id" value={e.id} />
                    <label className="text-sm">
                      אימייל
                      <input
                        name="email"
                        type="email"
                        required
                        dir="ltr"
                        defaultValue={String(e.email)}
                        className="mt-1 w-full rounded-xl border border-line px-3 py-2"
                      />
                    </label>
                    <label className="text-sm">
                      שם מלא
                      <input
                        name="fullName"
                        defaultValue={e.full_name ?? ""}
                        className="mt-1 w-full rounded-xl border border-line px-3 py-2"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="isActive"
                        defaultChecked={e.is_active}
                        className="h-5 w-5 accent-[#46b800]"
                      />
                      פעיל
                    </label>
                  </AdminActionForm>
                </details>

                <AdminActionForm
                  action={deleteStaffEmailAction}
                  submitLabel="הסרה מהרשימה"
                  danger
                  className="mt-1"
                >
                  <input type="hidden" name="id" value={e.id} />
                </AdminActionForm>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">ייבוא סגל מקובץ CSV</h2>
        <p className="mt-1 text-sm text-muted">
          עמודות: <code dir="ltr">email</code>, <code dir="ltr">full_name</code> (אופציונלי). שורה ראשונה = כותרות.
        </p>
        <AdminCsvImport action={importStaffCsvAction} />
      </section>
    </div>
  );
}
