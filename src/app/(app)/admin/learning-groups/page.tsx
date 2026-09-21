import { redirect } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import LearningGroupForm, {
  type LearningGroupFormValues,
} from "@/components/learning-groups/LearningGroupForm";
import LearningGroupWindowsManager, {
  type LgregWindowRow,
} from "@/components/learning-groups/LearningGroupWindowsManager";
import { formatWeeklySlotsHe, normalizeTime, type WeeklySlot } from "@/lib/schedule";

export const metadata = { title: "ניהול · קבוצות למידה" };

export default async function AdminLearningGroupsPage() {
  const me = await requireMe();
  // learning-group definition management: leadership OR super_admin
  if (!hasRole(me, "leadership") && !hasRole(me, "super_admin")) {
    redirect("/?error=אין%20הרשאת%20הנהלה");
  }

  const supabase = await createClient();
  const [
    lgRes,
    slotsRes,
    staffLeadersRes,
    studentLeadersRes,
    profilesRes,
    studentsRes,
    windowsRes,
    windowGroupsRes,
  ] = await Promise.all([
    supabase.from("learning_groups").select("id, name, description, is_active").order("name"),
    supabase
      .from("learning_group_weekly_slots")
      .select("learning_group_id, weekday, start_time, end_time"),
    supabase
      .from("learning_group_staff_leaders")
      .select("learning_group_id, staff_id"),
    supabase
      .from("learning_group_student_leaders")
      .select("learning_group_id, student_id"),
    supabase
      .from("profiles")
      .select("id, email, full_name, auth_user_id")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("students")
      .select("id, first_name, last_name")
      .eq("is_archived", false)
      .order("first_name"),
    supabase
      .from("learning_group_registration_windows")
      .select("id, title, opens_at, closes_at, is_revoked, encrypted_token, profiles(full_name)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("learning_group_registration_window_groups")
      .select("registration_window_id, learning_group_id, learning_groups(name)"),
  ]);

  const staffOptions = (profilesRes.data ?? []).map((p) => {
    const row = p as unknown as {
      id: string;
      email: string;
      full_name: string | null;
      auth_user_id: string | null;
    };
    return {
      id: row.id,
      label: row.full_name ?? row.email,
      hint: row.auth_user_id === null ? "טרם התחבר/ה" : undefined,
    };
  });

  const studentOptions = (studentsRes.data ?? []).map((s) => {
    const row = s as unknown as { id: string; first_name: string; last_name: string };
    return { id: row.id, label: `${row.first_name} ${row.last_name}` };
  });

  const slotsByGroup = new Map<string, WeeklySlot[]>();
  for (const s of slotsRes.data ?? []) {
    const row = s as unknown as {
      learning_group_id: string;
      weekday: number;
      start_time: string;
      end_time: string;
    };
    slotsByGroup.set(row.learning_group_id, [
      ...(slotsByGroup.get(row.learning_group_id) ?? []),
      { weekday: row.weekday, startTime: normalizeTime(row.start_time), endTime: normalizeTime(row.end_time) },
    ]);
  }

  const staffByGroup = new Map<string, string[]>();
  for (const l of staffLeadersRes.data ?? []) {
    staffByGroup.set(l.learning_group_id, [
      ...(staffByGroup.get(l.learning_group_id) ?? []),
      l.staff_id,
    ]);
  }
  const studentLeadersByGroup = new Map<string, string[]>();
  for (const l of studentLeadersRes.data ?? []) {
    studentLeadersByGroup.set(l.learning_group_id, [
      ...(studentLeadersByGroup.get(l.learning_group_id) ?? []),
      l.student_id,
    ]);
  }

  const learningGroups = (lgRes.data ?? []).map((g) => {
    const row = g as unknown as {
      id: string;
      name: string;
      description: string | null;
      is_active: boolean;
    };
    return {
      ...row,
      slots: slotsByGroup.get(row.id) ?? [],
      staffLeaderIds: staffByGroup.get(row.id) ?? [],
      studentLeaderIds: studentLeadersByGroup.get(row.id) ?? [],
    };
  });

  const groupNamesByWindow = new Map<string, string[]>();
  for (const wg of windowGroupsRes.data ?? []) {
    const row = wg as unknown as {
      registration_window_id: string;
      learning_groups: { name: string } | null;
    };
    if (!row.learning_groups) continue;
    groupNamesByWindow.set(row.registration_window_id, [
      ...(groupNamesByWindow.get(row.registration_window_id) ?? []),
      row.learning_groups.name,
    ]);
  }

  const windows: LgregWindowRow[] = (windowsRes.data ?? []).map((w) => {
    const row = w as unknown as {
      id: string;
      title: string;
      opens_at: string;
      closes_at: string;
      is_revoked: boolean;
      encrypted_token: string | null;
      profiles: { full_name: string | null } | null;
    };
    return {
      id: row.id,
      title: row.title,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      isRevoked: row.is_revoked,
      hasRecoverableLink: Boolean(row.encrypted_token),
      groupNames: groupNamesByWindow.get(row.id) ?? [],
      createdByName: row.profiles?.full_name ?? null,
    };
  });

  const emptyForm: LearningGroupFormValues = {
    name: "",
    description: "",
    isActive: true,
    slots: [{ weekday: 0, startTime: "16:00", endTime: "17:30" }],
    staffLeaderIds: [],
    studentLeaderIds: [],
  };

  return (
    <div className="flex flex-col gap-8">
      {/* ------------------------------------------- create definition --- */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">הוספת קבוצת למידה</h2>
        <div className="mt-3">
          <LearningGroupForm
            values={emptyForm}
            staffOptions={staffOptions}
            studentOptions={studentOptions}
            submitLabel="הוספה"
          />
        </div>
      </section>

      {/* --------------------------------------------- edit definitions -- */}
      <section className="flex flex-col gap-3">
        <h2 className="font-extrabold">קבוצות למידה ({learningGroups.length})</h2>
        {learningGroups.length === 0 && (
          <p className="text-sm text-muted">אין קבוצות למידה.</p>
        )}
        <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
          {learningGroups.map((g) => (
            <article
              key={g.id}
              className={`rounded-2xl border border-line bg-surface p-4 ${
                g.is_active ? "" : "opacity-70"
              }`}
            >
              <p className="font-bold">
                {g.name}
                {!g.is_active && (
                  <span className="mr-2 rounded-full bg-line px-2 py-0.5 text-[11px] font-bold text-muted">
                    לא פעילה
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {g.slots.length > 0 ? formatWeeklySlotsHe(g.slots) : "אין מפגשים"}
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-bold">עריכה</summary>
                <div className="mt-2">
                  <LearningGroupForm
                    values={{
                      id: g.id,
                      name: g.name,
                      description: g.description ?? "",
                      isActive: g.is_active,
                      slots: g.slots.map((s) => ({
                        weekday: s.weekday,
                        startTime: s.startTime,
                        endTime: s.endTime,
                      })),
                      staffLeaderIds: g.staffLeaderIds,
                      studentLeaderIds: g.studentLeaderIds,
                    }}
                    staffOptions={staffOptions}
                    studentOptions={studentOptions}
                  />
                </div>
              </details>
            </article>
          ))}
        </div>
      </section>

      {/* ------------------------------------------ registration windows -- */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <LearningGroupWindowsManager
          windows={windows}
          learningGroups={learningGroups.map((g) => ({
            id: g.id,
            name: g.name,
            isActive: g.is_active,
          }))}
        />
      </section>
    </div>
  );
}
