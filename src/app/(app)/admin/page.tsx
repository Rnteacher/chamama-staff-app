import Link from "next/link";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import ViewAsEntry, { type ViewAsStaffOption } from "@/components/view-as/ViewAsEntry";

export const metadata = { title: "ניהול · סקירה" };

const ACTION_LABELS: Record<string, string> = {
  message_general_visibility_granted: "אישור נראות כללית לעדכון",
  message_general_visibility_revoked: "ביטול נראות כללית לעדכון",
  student_message_edited: "עדכון הודעת חניך נערך",
  student_message_deleted: "עדכון הודעת חניך נמחק",
  meeting_schedule_create: "קביעת פגישה שבועית",
  meeting_schedule_update: "עריכת פגישה שבועית",
  meeting_schedule_deactivated: "מחיקת פגישה שבועית",
  meeting_report_submitted: "דיווח פגישה נשלח",
  meeting_report_updated: "דיווח פגישה נערך",
  meeting_report_deleted: "דיווח פגישה נמחק",
  intake_window_create: "יצירת טופס קבלה ציבורי",
  intake_window_revoke: "ביטול טופס קבלה ציבורי",
  intake_token_regenerated: "הנפקת קישור חדש לטופס קבלה",
  intake_token_reissued: "הנפקת קישור חדש לטופס קבלה",
  intake_master_assigned: "שיבוץ מאסטר/ית לפרויקט",
  form_create: "יצירת טופס",
  form_publish: "פרסום טופס",
  form_archive: "הוצאת טופס משימוש",
  form_delete_draft: "מחיקת טופס טיוטה",
  form_campaign_create: "יצירת קמפיין טופס",
  form_campaign_revoke: "ביטול קמפיין טופס",
  form_submission_created: "שליחת טופס",
  staff_member_create: "הוספת איש/אשת סגל",
};

const ENTITY_LABELS: Record<string, string> = {
  student_message: "עדכון חניך",
  meeting_schedule: "פגישה שבועית",
  meeting_report: "דיווח פגישה",
  intake_window: "טופס קבלה ציבורי",
  intake_submission: "הצהרת כוונות",
  form_definition: "טופס",
  form_campaign: "קמפיין טופס",
  form_submission: "שליחת טופס",
  staff_member: "איש/אשת סגל",
};

export default async function AdminOverviewPage() {
  const me = await requireMe();
  const isSuper = hasRole(me, "super_admin");
  const supabase = await createClient();

  const [staffRes, studentsRes, groupsRes, majorsRes, mentorsRes, mastersRes, majorHeadsRes, rolesRes, logRes] =
    await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("students").select("id", { count: "exact", head: true }),
      supabase.from("greenhouse_groups").select("id", { count: "exact", head: true }),
      supabase.from("majors").select("id", { count: "exact", head: true }),
      supabase.from("group_mentors").select("staff_id"),
      supabase.from("master_assignments").select("staff_id"),
      supabase.from("major_heads").select("staff_id"),
      supabase.from("user_roles").select("staff_id, role").eq("role", "project_coordinator"),
      supabase.rpc("recent_audit_logs", { p_limit: 30 }),
    ]);

  const logRows = (logRes.data ?? []) as Array<{
    created_at: string;
    actor_name: string | null;
    action: string;
    entity_type: string | null;
  }>;

  const mentorIds = new Set((mentorsRes.data ?? []).map((m) => m.staff_id));
  const masterIds = new Set((mastersRes.data ?? []).map((m) => m.staff_id));
  const majorHeadIds = new Set((majorHeadsRes.data ?? []).map((m) => m.staff_id));
  const coordinatorIds = new Set((rolesRes.data ?? []).map((r) => r.staff_id));

  const activeStaff = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("is_active", true)
    .order("full_name");

  const viewAsStaff: ViewAsStaffOption[] = (activeStaff.data ?? []).map((p) => ({
    id: p.id,
    name: p.full_name ?? p.id,
    is_mentor: mentorIds.has(p.id),
    is_master: masterIds.has(p.id),
    is_major_head: majorHeadIds.has(p.id),
    is_project_coordinator: coordinatorIds.has(p.id),
  }));

  const stats = [
    { label: "אנשי סגל בספר", value: staffRes.count ?? 0, href: "/admin/staff" },
    { label: "חניכים", value: studentsRes.count ?? 0, href: "/admin/students" },
    { label: "קבוצות", value: groupsRes.count ?? 0, href: "/admin/groups" },
    { label: "מגמות", value: majorsRes.count ?? 0, href: "/admin/majors" },
  ];

  const canManageEmployment =
    me.roles.includes("employment_coordinator") ||
    me.roles.includes("leadership") ||
    me.roles.includes("super_admin");

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:gap-3">
        {stats.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              className="block rounded-2xl border border-line bg-surface p-4 hover:bg-brand-soft/40"
            >
              <span className="block text-2xl font-extrabold">{s.value}</span>
              <span className="text-sm text-muted">{s.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      {canManageEmployment && (
        <Link
          href="/admin/employment"
          className="block rounded-2xl border border-line bg-surface p-4 hover:bg-brand-soft/40"
        >
          <span className="block text-lg font-extrabold">ניהול תעסוקה</span>
          <span className="text-sm text-muted">
            שיבוצי עבודה, ימי עבודה מתוכננים וצבירת שעות (200 שעות · שכבות ב/ג/ד)
          </span>
        </Link>
      )}

      {isSuper && <ViewAsEntry staff={viewAsStaff} />}

      <section aria-labelledby="activity-log-heading" className="rounded-2xl border border-line bg-surface p-4 lg:p-5">
        <h2 id="activity-log-heading" className="font-extrabold">לוג פעילות</h2>
        <p className="mt-1 text-sm text-muted">הפעולות האחרונות במערכת, מהחדשה לישנה.</p>
        {logRows.length === 0 ? (
          <p className="mt-3 text-sm text-muted">אין עדיין פעילות להצגה.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {logRows.map((row, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-x-2 border-b border-line/50 pb-1.5 last:border-0 lg:grid lg:grid-cols-[10rem_minmax(8rem,auto)_1fr_auto] lg:gap-3"
              >
                <time dateTime={row.created_at} className="shrink-0 text-xs text-muted lg:text-sm">
                  {new Date(row.created_at).toLocaleString("he-IL", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span className="font-bold">{row.actor_name ?? "מערכת"}</span>
                <span>{ACTION_LABELS[row.action] ?? row.action}</span>
                {row.entity_type && ENTITY_LABELS[row.entity_type] && (
                  <span className="text-xs text-muted lg:justify-self-start">· {ENTITY_LABELS[row.entity_type]}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
