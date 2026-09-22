import Link from "next/link";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getViewAsState } from "@/lib/view-as";
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
  intake_window_create: "יצירת טופס הצהרת כוונות",
  intake_window_revoke: "ביטול טופס הצהרת כוונות",
  intake_window_restored: "הפעלת טופס הצהרת כוונות מחדש",
  intake_window_deleted: "מחיקת טופס הצהרת כוונות",
  intake_token_regenerated: "הנפקת קישור חדש להצהרת כוונות",
  intake_token_reissued: "הנפקת קישור חדש להצהרת כוונות",
  intake_token_added: "הנפקת קישור נוסף להצהרת כוונות",
  intake_master_assigned: "שיבוץ מאסטר/ית לפרויקט",
  form_create: "יצירת טופס",
  form_publish: "פרסום טופס",
  form_archive: "הוצאת טופס משימוש",
  form_delete_draft: "מחיקת טופס טיוטה",
  form_campaign_create: "יצירת קמפיין טופס",
  form_campaign_revoke: "ביטול קמפיין טופס",
  form_submission_created: "שליחת טופס",
  staff_member_create: "הוספת איש/אשת צוות",
  staff_roles_set: "עדכון תפקידי צוות",
  staff_csv_import: "ייבוא צוות מקובץ CSV",
  employment_override_set: "קביעת זכאות תעסוקה ידנית",
  employment_override_changed: "שינוי זכאות תעסוקה ידנית",
  employment_override_reset: "איפוס זכאות תעסוקה לברירת המחדל",
  view_as_enter: "כניסה למצב צפייה",
  view_as_exit: "יציאה ממצב צפייה",
};

const ENTITY_LABELS: Record<string, string> = {
  student_message: "עדכון חניך",
  meeting_schedule: "פגישה שבועית",
  meeting_report: "דיווח פגישה",
  intake_window: "טופס הצהרת כוונות",
  intake_submission: "הצהרת כוונות",
  form_definition: "טופס",
  form_campaign: "קמפיין טופס",
  form_submission: "שליחת טופס",
  staff_member: "איש/אשת צוות",
  student: "חניך/ה",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 15;

function pageHref(page: number, actor: string | null): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (actor) params.set("actor", actor);
  const qs = params.toString();
  return qs ? `/admin?${qs}` : "/admin";
}

export default async function AdminOverviewPage({
  searchParams,
}: PageProps<"/admin">) {
  const [me, viewAs, supabase, params] = await Promise.all([
    requireMe(),
    getViewAsState(),
    createClient(),
    searchParams,
  ]);
  const isSuper = hasRole(me, "super_admin");
  const rawPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const actor =
    typeof params.actor === "string" && UUID_RE.test(params.actor)
      ? params.actor
      : null;

  const [mentorsRes, mastersRes, majorHeadsRes, rolesRes, actorsRes, logRes, totalRes, activeStaff] =
    await Promise.all([
      supabase.from("group_mentors").select("staff_id"),
      supabase.from("master_assignments").select("staff_id"),
      supabase.from("major_heads").select("staff_id"),
      supabase.from("user_roles").select("staff_id, role").eq("role", "project_coordinator"),
      supabase.rpc("audit_log_actors"),
      supabase.rpc("audit_logs_page", {
        p_page: page,
        p_page_size: PAGE_SIZE,
        p_actor: actor,
      }),
      supabase.rpc("audit_logs_total", { p_actor: actor }),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .order("full_name"),
    ]);

  const logRows = (logRes.data ?? []) as Array<{
    created_at: string;
    actor_staff_id: string | null;
    actor_name: string | null;
    action: string;
    entity_type: string | null;
  }>;
  const total = Number(totalRes.data ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const actors = (actorsRes.data ?? []) as Array<{ staff_id: string; full_name: string }>;

  const mentorIds = new Set((mentorsRes.data ?? []).map((m) => m.staff_id));
  const masterIds = new Set((mastersRes.data ?? []).map((m) => m.staff_id));
  const majorHeadIds = new Set((majorHeadsRes.data ?? []).map((m) => m.staff_id));
  const coordinatorIds = new Set((rolesRes.data ?? []).map((r) => r.staff_id));

  const viewAsStaff: ViewAsStaffOption[] = (activeStaff.data ?? []).map((p) => ({
    id: p.id,
    name: p.full_name ?? p.id,
    is_mentor: mentorIds.has(p.id),
    is_master: masterIds.has(p.id),
    is_major_head: majorHeadIds.has(p.id),
    is_project_coordinator: coordinatorIds.has(p.id),
  }));

  const canManageEmployment =
    me.roles.includes("employment_coordinator") ||
    me.roles.includes("leadership") ||
    me.roles.includes("super_admin");

  // pager: a small window of numbered pages around the current one
  const windowSize = 5;
  const windowStart = Math.max(1, Math.min(page - 2, pageCount - windowSize + 1));
  const windowPages: number[] = [];
  for (let p = windowStart; p <= Math.min(pageCount, windowStart + windowSize - 1); p++) {
    windowPages.push(p);
  }

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 lg:gap-3">
        <li>
          <Link
            href="/admin/intake"
            className="block rounded-2xl border border-line bg-surface p-4 hover:bg-brand-soft/40"
          >
            <span className="block text-lg font-extrabold">הצהרת כוונות</span>
            <span className="text-sm text-muted">
              טפסים ציבוריים, הצהרות שהתקבלו ושיבוץ מאסטר/ית
            </span>
          </Link>
        </li>
        {canManageEmployment && (
          <li>
            <Link
              href="/admin/employment"
              className="block rounded-2xl border border-line bg-surface p-4 hover:bg-brand-soft/40"
            >
              <span className="block text-lg font-extrabold">ניהול תעסוקה</span>
              <span className="text-sm text-muted">
                שיבוצי עבודה, ימי עבודה מתוכננים וצבירת שעות (200 שעות)
              </span>
            </Link>
          </li>
        )}
        <li>
          <Link
            href="/admin/learning-groups"
            className="block rounded-2xl border border-line bg-surface p-4 hover:bg-brand-soft/40"
          >
            <span className="block text-lg font-extrabold">קבוצות למידה</span>
            <span className="text-sm text-muted">
              הגדרת קבוצות, מפגשים שבועיים וחלונות הרשמה
            </span>
          </Link>
        </li>
      </ul>

      {isSuper && !viewAs.active && <ViewAsEntry staff={viewAsStaff} />}

      <section aria-labelledby="activity-log-heading" className="rounded-2xl border border-line bg-surface p-4 lg:p-5">
        <h2 id="activity-log-heading" className="font-extrabold">לוג פעילות</h2>

        {/* actor filter — composes with pagination via the query string */}
        <form method="get" action="/admin" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label className="text-xs font-semibold text-muted">
            איש/אשת צוות
            <select
              name="actor"
              defaultValue={actor ?? ""}
              className="mr-2 rounded-xl border border-line bg-white px-3 py-2"
            >
              <option value="">הכל</option>
              {actors.map((a) => (
                <option key={a.staff_id} value={a.staff_id}>
                  {a.full_name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-full border border-brand-dark px-4 py-2 text-xs font-bold text-brand-dark hover:bg-brand-soft"
          >
            הצגה
          </button>
        </form>

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

        {pageCount > 1 && (
          <nav aria-label="עימוד לוג פעילות" className="mt-4 flex flex-wrap items-center gap-1.5 text-sm">
            {page > 1 ? (
              <Link
                href={pageHref(page - 1, actor)}
                className="rounded-full border border-line bg-surface px-3 py-1.5 font-bold hover:bg-bg"
              >
                הקודם
              </Link>
            ) : (
              <span className="rounded-full border border-line bg-bg px-3 py-1.5 font-bold text-muted opacity-50">הקודם</span>
            )}
            {windowStart > 1 && (
              <>
                <Link href={pageHref(1, actor)} className="rounded-full border border-line bg-surface px-3 py-1.5 hover:bg-bg">1</Link>
                <span className="text-muted">…</span>
              </>
            )}
            {windowPages.map((p) =>
              p === page ? (
                <span
                  key={p}
                  aria-current="page"
                  className="rounded-full border border-brand-dark bg-brand-soft px-3 py-1.5 font-extrabold text-ink"
                >
                  {p}
                </span>
              ) : (
                <Link
                  key={p}
                  href={pageHref(p, actor)}
                  className="rounded-full border border-line bg-surface px-3 py-1.5 hover:bg-bg"
                >
                  {p}
                </Link>
              )
            )}
            {windowStart + windowPages.length - 1 < pageCount && (
              <>
                <span className="text-muted">…</span>
                <Link href={pageHref(pageCount, actor)} className="rounded-full border border-line bg-surface px-3 py-1.5 hover:bg-bg">{pageCount}</Link>
              </>
            )}
            {page < pageCount ? (
              <Link
                href={pageHref(page + 1, actor)}
                className="rounded-full border border-line bg-surface px-3 py-1.5 font-bold hover:bg-bg"
              >
                הבא
              </Link>
            ) : (
              <span className="rounded-full border border-line bg-bg px-3 py-1.5 font-bold text-muted opacity-50">הבא</span>
            )}
          </nav>
        )}
      </section>
    </div>
  );
}
