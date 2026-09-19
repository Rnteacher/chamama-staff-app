import { requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  upsertStudentAction,
  archiveStudentAction,
  setMastersAction,
  importStudentsCsvAction,
} from "@/lib/actions/admin";
import AdminActionForm from "@/components/admin/AdminActionForm";
import AdminCsvImport from "@/components/admin/AdminCsvImport";

export const metadata = { title: "ניהול · חניכים" };

export default async function AdminStudentsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const [studentsRes, groupsRes, majorsRes, profilesRes, mastersRes] =
    await Promise.all([
      supabase
        .from("students")
        .select("id, first_name, last_name, is_archived, group_id, major_id, greenhouse_groups(name), majors(name)")
        .order("first_name"),
      supabase.from("greenhouse_groups").select("id, name").order("name"),
      supabase.from("majors").select("id, name").order("name"),
      supabase
        .from("profiles")
        .select("id, email, full_name, auth_user_id")
        .eq("is_active", true)
        .order("full_name"),
      supabase.from("master_assignments").select("student_id, staff_id"),
    ]);

  const groups = groupsRes.data ?? [];
  const majors = majorsRes.data ?? [];
  const staff = profilesRes.data ?? [];

  const mastersByStudent = new Map<string, string[]>();
  for (const m of mastersRes.data ?? []) {
    mastersByStudent.set(m.student_id, [
      ...(mastersByStudent.get(m.student_id) ?? []),
      m.staff_id,
    ]);
  }

  const students = studentsRes.data ?? [];
  const active = students.filter((s) => !s.is_archived);
  const archived = students.filter((s) => s.is_archived);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">הוספת חניך/ה</h2>
        <AdminActionForm
          action={upsertStudentAction}
          submitLabel="הוספה"
          className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <label className="text-sm">
            שם פרטי
            <input name="firstName" required className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
          <label className="text-sm">
            שם משפחה
            <input name="lastName" required className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
          <label className="text-sm">
            קבוצה
            <select name="groupId" className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2">
              <option value="">— ללא —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            מגמה
            <select name="majorId" className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2">
              <option value="">— ללא —</option>
              {majors.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        </AdminActionForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-extrabold">חניכים פעילים ({active.length})</h2>
        {active.map((s) => (
          <StudentAdminRow
            key={s.id}
            student={s as unknown as StudentAdminData}
            groups={groups}
            majors={majors}
            staff={staff}
            masterIds={mastersByStudent.get(s.id) ?? []}
          />
        ))}
        {active.length === 0 && <p className="text-sm text-muted">אין חניכים פעילים.</p>}
      </section>

      {archived.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-extrabold">ארכיון ({archived.length})</h2>
          {archived.map((s) => (
            <StudentAdminRow
              key={s.id}
              student={s as unknown as StudentAdminData}
              groups={groups}
              majors={majors}
              staff={staff}
              masterIds={mastersByStudent.get(s.id) ?? []}
            />
          ))}
        </section>
      )}

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">ייבוא חניכים מקובץ CSV</h2>
        <p className="mt-1 text-sm text-muted">
          עמודות: <code dir="ltr">first_name</code>, <code dir="ltr">last_name</code>,{" "}
          <code dir="ltr">group</code> (שם קבוצה קיימת), <code dir="ltr">major</code> (אופציונלי).
        </p>
        <AdminCsvImport action={importStudentsCsvAction} />
      </section>
    </div>
  );
}

interface StudentAdminData {
  id: string;
  first_name: string;
  last_name: string;
  is_archived: boolean;
  group_id: string | null;
  major_id: string | null;
  greenhouse_groups: { name: string } | null;
  majors: { name: string } | null;
}

interface Option {
  id: string;
  name: string;
}
interface StaffOption {
  id: string;
  email: string;
  full_name: string | null;
  auth_user_id: string | null;
}

function StudentAdminRow({
  student,
  groups,
  majors,
  staff,
  masterIds,
}: {
  student: StudentAdminData;
  groups: Option[];
  majors: Option[];
  staff: StaffOption[];
  masterIds: string[];
}) {
  return (
    <article className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-bold">
            {student.first_name} {student.last_name}
            {student.is_archived && (
              <span className="mr-2 rounded-full border border-warn px-2 py-0.5 text-xs font-bold text-warn">
                ארכיון
              </span>
            )}
          </p>
          <p className="text-sm text-muted">
            {[student.greenhouse_groups?.name, student.majors?.name]
              .filter(Boolean)
              .join(" · ") || "ללא שיוך"}
          </p>
        </div>
        <AdminActionForm
          action={archiveStudentAction}
          submitLabel={student.is_archived ? "שחזור" : "העברה לארכיון"}
          danger={!student.is_archived}
          hideFeedback
        >
          <input type="hidden" name="id" value={student.id} />
          <input
            type="hidden"
            name="isArchived"
            value={student.is_archived ? "false" : "true"}
          />
        </AdminActionForm>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <details>
          <summary className="cursor-pointer text-sm font-bold">עריכה</summary>
          <AdminActionForm
            action={upsertStudentAction}
            submitLabel="שמירה"
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <input type="hidden" name="id" value={student.id} />
            <label className="text-sm">
              שם פרטי
              <input
                name="firstName"
                required
                defaultValue={student.first_name}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="text-sm">
              שם משפחה
              <input
                name="lastName"
                required
                defaultValue={student.last_name}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2"
              />
            </label>
            <label className="text-sm">
              קבוצה
              <select
                name="groupId"
                defaultValue={student.group_id ?? ""}
                className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2"
              >
                <option value="">— ללא —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              מגמה
              <select
                name="majorId"
                defaultValue={student.major_id ?? ""}
                className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2"
              >
                <option value="">— ללא —</option>
                {majors.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                name="isArchived"
                defaultChecked={student.is_archived}
                className="h-5 w-5 accent-[#46b800]"
              />
              בארכיון
            </label>
          </AdminActionForm>
        </details>

        <details>
          <summary className="cursor-pointer text-sm font-bold">
            מאסטרים ({masterIds.length})
          </summary>
          <AdminActionForm action={setMastersAction} submitLabel="שמירת מאסטרים" className="mt-2">
            <input type="hidden" name="studentId" value={student.id} />
            <fieldset className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {staff.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="staffIds"
                    value={p.id}
                    defaultChecked={masterIds.includes(p.id)}
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
}
