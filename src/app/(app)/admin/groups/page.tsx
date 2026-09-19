import { createClient } from "@/lib/supabase/server";
import {
  upsertGroupAction,
  setGroupMentorsAction,
} from "@/lib/actions/admin";
import AdminActionForm from "@/components/admin/AdminActionForm";

export const metadata = { title: "ניהול · קבוצות" };

export default async function AdminGroupsPage() {
  const supabase = await createClient();
  const [groupsRes, mentorsRes, profilesRes] = await Promise.all([
    supabase.from("greenhouse_groups").select("id, name").order("name"),
    supabase.from("group_mentors").select("group_id, staff_id"),
    supabase
      .from("profiles")
      .select("id, email, full_name, auth_user_id")
      .eq("is_active", true)
      .order("full_name"),
  ]);

  const staff = profilesRes.data ?? [];
  const mentorsByGroup = new Map<string, string[]>();
  for (const m of mentorsRes.data ?? []) {
    mentorsByGroup.set(m.group_id, [...(mentorsByGroup.get(m.group_id) ?? []), m.staff_id]);
  }

  const groups = groupsRes.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">הוספת קבוצה</h2>
        <AdminActionForm
          action={upsertGroupAction}
          submitLabel="הוספה"
          className="mt-3 flex gap-2"
        >
          <label className="flex-1 text-sm">
            שם הקבוצה
            <input name="name" required className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
        </AdminActionForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-extrabold">קבוצות ({groups.length})</h2>
        {groups.map((g) => {
          const mentorIds = mentorsByGroup.get(g.id) ?? [];
          return (
            <article key={g.id} className="rounded-2xl border border-line bg-surface p-4">
              <p className="font-bold">{g.name}</p>
              <div className="mt-3 flex flex-col gap-2">
                <details>
                  <summary className="cursor-pointer text-sm font-bold">שינוי שם</summary>
                  <AdminActionForm action={upsertGroupAction} submitLabel="שמירה" className="mt-2 flex gap-2">
                    <input type="hidden" name="id" value={g.id} />
                    <label className="flex-1 text-sm">
                      שם הקבוצה
                      <input
                        name="name"
                        required
                        defaultValue={g.name}
                        className="mt-1 w-full rounded-xl border border-line px-3 py-2"
                      />
                    </label>
                  </AdminActionForm>
                </details>
                <details>
                  <summary className="cursor-pointer text-sm font-bold">
                    מנטורים ({mentorIds.length})
                  </summary>
                  <AdminActionForm action={setGroupMentorsAction} submitLabel="שמירת מנטורים" className="mt-2">
                    <input type="hidden" name="groupId" value={g.id} />
                    <fieldset className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {staff.map((p) => (
                        <label key={p.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="staffIds"
                            value={p.id}
                            defaultChecked={mentorIds.includes(p.id)}
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
        {groups.length === 0 && <p className="text-sm text-muted">אין קבוצות.</p>}
      </section>
    </div>
  );
}
