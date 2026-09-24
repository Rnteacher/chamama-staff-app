import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EmploymentOverviewData } from "@/lib/employment";

/**
 * Corrections pass: the student-page Employment section is informational
 * (no allow/deny), and Home shows major heads their major's students
 * (canonical major_heads relationship, never roles).
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock("@/lib/actions/employment", () => ({
  setEmploymentOverrideAction: async () => ({ ok: true }),
}));

const src = (p: string) => readFileSync(path.resolve(__dirname, "../../src", p), "utf8");
const migration = (name: string) =>
  readFileSync(path.resolve(__dirname, "../../supabase/migrations", name), "utf8");

// ========================================================== EMPLOYMENT =====
describe("student-page Employment section — informational only", () => {
  const base: EmploymentOverviewData = {
    eligible: true,
    override: null,
    cohort_note: null,
    placement: null,
    weekly_slots: [],
    exceptions: [],
    total_minutes: 0,
    target_minutes: 12000,
    recent_logs: [],
    can_manage: false,
  };
  const placement = {
    id: "p1", workplace_name: "בית קפה", contact_name: null, contact_phone: null,
    start_date: "2026-09-01", end_date: null, is_active: true, notes: null,
  };
  const ALLOW_DENY = /לאפשר תעסוקה|זכאות תעסוקה ידנית|ברירת מחדל|<select/;

  async function card(data: EmploymentOverviewData) {
    const Card = (await import("@/components/employment/StudentEmploymentCard")).default;
    return renderToStaticMarkup(<Card data={data} studentId="s1" />);
  }

  it("older (default-eligible) student → section shown, no allow/deny, no eligibility copy", async () => {
    const html = await card(base);
    expect(html).toContain("תעסוקה</h2>");
    expect(html).toContain("אין שיבוץ לעבודה.");
    expect(html).not.toMatch(ALLOW_DENY);
    expect(html).not.toContain("לא משתתף/ת");
    expect(html).not.toContain("השנתון");
  });

  it("existing placement / hours / logs still render", async () => {
    const html = await card({
      ...base,
      placement,
      weekly_slots: [{ weekday: 2, start_time: "08:30", end_time: "15:00" }],
      total_minutes: 1200,
      recent_logs: [
        { id: "l1", work_date: "2026-09-10", start_time: "08:30", end_time: "15:00", duration_minutes: 390, note: null },
      ],
    });
    expect(html).toContain("בית קפה");
    expect(html).toContain("יום שלישי 08:30–15:00");
    expect(html).toContain("20 שעות / 200 שעות");
    expect(html).toContain("שעות אחרונות");
    expect(html).not.toMatch(ALLOW_DENY);
  });

  it("youngest cohort explicitly added (override eligible) → section, no allow/deny inside", async () => {
    const html = await card({ ...base, override: "eligible" });
    expect(html).toContain("תעסוקה</h2>");
    expect(html).not.toMatch(ALLOW_DENY);
  });

  it("youngest cohort default → nothing; existing history stays visible without eligibility copy", async () => {
    const young = {
      ...base,
      eligible: false,
      cohort_note: "קבוצת השנתון הצעירה — לא נכללת בתוכנית התעסוקה",
    };
    expect(await card(young)).toBe("");
    const withHistory = await card({ ...young, placement, total_minutes: 12000 });
    expect(withHistory).toContain("בית קפה");
    expect(withHistory).not.toContain("השנתון");
    expect(withHistory).not.toContain("לא משתתף/ת");
    expect(withHistory).not.toMatch(ALLOW_DENY);
  });

  it("no override control anywhere on the student page; cohort names stay out of React", () => {
    const page = src("app/(app)/students/[id]/page.tsx");
    const cardSrc = src("components/employment/StudentEmploymentCard.tsx");
    for (const f of [page, cardSrc]) {
      expect(f).not.toContain("EmploymentOverrideControl");
      expect(f).not.toContain("canManageOverride");
      expect(f).not.toContain("EMPLOYMENT_OVERRIDE_LABELS");
      expect(f).not.toContain("hebrewCohortRank");
      expect(f).not.toMatch(/קבוצת (זית|שקד|רימון|דקל)/);
    }
    // the only employment action on the page is the separate add action
    expect(page).toContain("!employmentApplies(employment)");
    expect(src("components/employment/AddToEmploymentButton.tsx")).toContain(
      'fd.set("override", "eligible")'
    );
  });
});

// ==================================================== MAJOR-HEAD HOME ======
describe("Home — major-head students", () => {
  const row = (id: string) => ({
    student_id: id, student_name: `חניך ${id}`, group_name: null,
    has_project: false, project_major_name: null, intent_text: null,
    primary_master_name: null, master_names: null, status: null,
    status_source: null, last_report_at: null, intervention: null,
    mentor_last_meeting_at: null, mentor_last_status: null,
    master_last_meeting_at: null, master_last_status: null,
    mentor_next_meeting_at: null, mentor_next_meeting_weekday: null,
    mentor_next_meeting_time: null, master_next_meeting_at: null,
    master_next_meeting_weekday: null, master_next_meeting_time: null,
  });
  const mobile = (id: string) => ({ id, firstName: "חניך", lastName: id, groupName: null, unread: 0 });

  it("scopes the major list from the canonical set only, one row per student", async () => {
    const { scopeHomeStudents } = await import("@/lib/home-students");
    const rows = [row("a"), row("b"), row("c"), row("b")];
    const s = scopeHomeStudents(rows, new Set(["a"]), new Set(), new Set(["b", "c"]));
    expect(s.mentorRows.map((r) => r.student_id)).toEqual(["a"]);
    expect(s.masterRows).toHaveLength(0);
    expect(s.majorRows.map((r) => r.student_id)).toEqual(["b", "c"]);
    // a broad (admin) dashboard with every student grants nothing by itself
    const none = scopeHomeStudents(rows, new Set(), new Set(), new Set());
    expect(none.majorRows).toHaveLength(0);
  });

  async function panel(views: { mentor?: string[]; master?: string[]; major?: string[] }) {
    const HomeStudentsPanel = (await import("@/components/home/HomeStudentsPanel")).default;
    const r = (ids: string[] = []) => ids.map(row);
    const m = (ids: string[] = []) => ids.map(mobile);
    return renderToStaticMarkup(
      <HomeStudentsPanel
        mentorRows={r(views.mentor)} masterRows={r(views.master)} majorRows={r(views.major)}
        mentorMobile={m(views.mentor)} masterMobile={m(views.master)} majorMobile={m(views.major)}
      />
    );
  }
  const tabs = (html: string) =>
    [...html.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map((x) => x[1]);

  it("relationship toggles: מנטור / מאסטר / מגמה only for relationships that exist", async () => {
    expect(tabs(await panel({ mentor: ["a"] }))).toEqual([]);
    expect(tabs(await panel({ master: ["a"] }))).toEqual([]);
    const majorOnly = await panel({ major: ["a", "b"] });
    expect(tabs(majorOnly)).toEqual([]);
    expect(majorOnly).toContain("החניכים שלי · מגמה");
    expect(tabs(await panel({ mentor: ["a"], master: ["b"] }))).toEqual(["מנטור", "מאסטר"]);
    expect(tabs(await panel({ mentor: ["a"], major: ["b"] }))).toEqual(["מנטור", "מגמה"]);
    expect(tabs(await panel({ master: ["a"], major: ["b"] }))).toEqual(["מאסטר", "מגמה"]);
    expect(tabs(await panel({ mentor: ["a"], master: ["b"], major: ["c"] }))).toEqual([
      "מנטור", "מאסטר", "מגמה",
    ]);
    expect(await panel({})).toBe("");
  });

  it("Home keys the major list on home_major_student_ids, never roles; View-As does not inherit it", () => {
    const home = src("app/(app)/page.tsx");
    expect(home).toContain('supabase.rpc("home_major_student_ids")');
    expect(home).toMatch(/majorHeadStudentIds = new Set\(\s*useViewAs\s*\?\s*\[\]/);
    const scoping = src("lib/home-students.ts");
    expect(scoping).not.toMatch(/roles\.|super_admin"|leadership"/);
  });

  it("migration uses the canonical is_major_head_for_student everywhere, keyed on the caller", () => {
    const m = migration("20260923000007_home_major_students.sql");
    const fn = (name: string) => {
      const i = m.indexOf(`create or replace function public.${name}`);
      return m.slice(i, m.indexOf("$$;", i));
    };
    expect(fn("dashboard_rows()")).toContain("or public.is_major_head_for_student(me.sid, s.id)");
    expect(fn("dashboard_rows()")).not.toContain("join public.major_heads mh on mh.major_id = sp.major_id");
    expect(fn("dashboard_rows_view_as(")).toContain(
      "(p_context = 'major_head' and public.is_major_head_for_student(p_target_staff_id, s.id))"
    );
    const ids = fn("home_major_student_ids()");
    expect(ids).toContain("public.current_staff_id()");
    expect(ids).toContain("public.is_major_head_for_student(me.sid, s.id)");
    expect(ids).not.toMatch(/staff_is_privileged|super_admin|leadership/);
    expect(m).toMatch(/revoke all on function public\.home_major_student_ids\(\) from public, anon;/);
  });
});
