import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Corrections-pass regression tests: navigation, permissions, terminology,
 * employment tri-state override and CSV filter composition.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

const src = (p: string) =>
  readFileSync(path.resolve(__dirname, "../../src", p), "utf8");
const migration = (name: string) =>
  readFileSync(
    path.resolve(__dirname, "../../supabase/migrations", name),
    "utf8"
  );

// ============================================================ NAVIGATION ====
describe("bottom navigation", () => {
  it("uses Home / Updates / Calendar(if authorized) / Groups / Settings — no Search, no More", async () => {
    const BottomNav = (await import("@/components/BottomNav")).default;
    const withCalendar = renderToStaticMarkup(
      <BottomNav totalUnread={3} showCalendar />
    );
    const withoutCalendar = renderToStaticMarkup(
      <BottomNav totalUnread={0} showCalendar={false} />
    );

    for (const html of [withCalendar, withoutCalendar]) {
      expect(html).toContain("בית");
      expect(html).toContain("עדכונים");
      expect(html).toContain("קבוצות");
      expect(html).toContain("הגדרות");
      expect(html).not.toContain("חיפוש");
      expect(html).not.toContain('href="/search"');
      expect(html).not.toContain('href="/more"');
    }
    expect(withCalendar).toContain("לוח שנה");
    expect(withCalendar).toContain('href="/calendar"');
    expect(withoutCalendar).not.toContain("לוח שנה");
    expect(withoutCalendar).not.toContain('href="/calendar"');
  });

  it("shows the unread badge only when there is something unread", async () => {
    const BottomNav = (await import("@/components/BottomNav")).default;
    const withUnread = renderToStaticMarkup(
      <BottomNav totalUnread={7} showCalendar={false} />
    );
    const atZero = renderToStaticMarkup(
      <BottomNav totalUnread={0} showCalendar={false} />
    );
    expect(withUnread).toContain(">7</span>");
    expect(atZero).not.toContain("עדכונים שלא נקראו");
  });
});

// ========================================================== PERMISSIONS =====
describe("management capability helper", () => {
  it("grants Management only to roles that genuinely own a management area", async () => {
    const { canAccessManagement } = await import("@/lib/permissions");
    expect(canAccessManagement(["super_admin"])).toBe(true);
    expect(canAccessManagement(["project_coordinator"])).toBe(true);
    expect(canAccessManagement(["employment_coordinator"])).toBe(true);
    expect(canAccessManagement(["leadership"])).toBe(true);
    // staff itself is NOT a management capability
    expect(canAccessManagement(["staff"])).toBe(false);
    expect(canAccessManagement(["mentor"])).toBe(false);
    expect(canAccessManagement(["master"])).toBe(false);
    expect(canAccessManagement(["major_head"])).toBe(false);
    expect(canAccessManagement(["counselor"])).toBe(false);
    expect(canAccessManagement([])).toBe(false);
  });

  it("the admin shell guard uses the helper (no hard-coded UI list)", () => {
    const adminLayout = src("app/(app)/admin/layout.tsx");
    expect(adminLayout).toContain("canAccessManagement(me.roles)");
    // a simulated ordinary staff member never reaches the management shell
    expect(adminLayout).toMatch(/viewAs\.active && viewAs\.roleContext !== "project_coordinator"/);
  });

  it("layout hides ניהול from anyone without a management capability", () => {
    const layout = src("app/(app)/layout.tsx");
    expect(layout).toContain("canManage");
    expect(layout).toMatch(/\{canManage && \(/);
  });
});

// ================================================ HOME STUDENT SOURCE =======
describe("home student scoping", () => {
  it("mentor/master lists come from the canonical relationship sets only", async () => {
    const { scopeHomeStudents } = await import("@/lib/home-students");
    const rows = [
      { student_id: "a" },
      { student_id: "b" },
      { student_id: "c" },
    ];
    const scoped = scopeHomeStudents(
      rows,
      new Set(["a", "b"]),
      new Set(["b", "c"])
    );
    expect(scoped.mentorRows.map((r) => r.student_id)).toEqual(["a", "b"]);
    expect(scoped.masterRows.map((r) => r.student_id)).toEqual(["b", "c"]);
    // neither relationship → nothing
    const none = scopeHomeStudents(rows, new Set([]), new Set([]));
    expect(none.mentorRows).toHaveLength(0);
    expect(none.masterRows).toHaveLength(0);
  });

  it("mentor+master renders the toggle; a single relationship does not", async () => {
    const HomeStudentsPanel = (await import("@/components/home/HomeStudentsPanel")).default;
    const row = {
      student_id: "a", student_name: "חניך", group_name: null,
      has_project: false, project_major_name: null, intent_text: null,
      primary_master_name: null, master_names: null, status: null,
      status_source: null, last_report_at: null, intervention: null,
      mentor_last_meeting_at: null, mentor_last_status: null,
      master_last_meeting_at: null, master_last_status: null,
      mentor_next_meeting_at: null, mentor_next_meeting_weekday: null,
      mentor_next_meeting_time: null, master_next_meeting_at: null,
      master_next_meeting_weekday: null, master_next_meeting_time: null,
    };
    const both = renderToStaticMarkup(
      <HomeStudentsPanel
        mentorRows={[row]}
        masterRows={[row]}
        mentorMobile={[]}
        masterMobile={[]}
      />
    );
    expect(both).toContain("מנטור");
    expect(both).toContain("מאסטר");
    expect(both).toMatch(/role="tablist"/);

    const onlyMaster = renderToStaticMarkup(
      <HomeStudentsPanel
        mentorRows={[]}
        masterRows={[row]}
        mentorMobile={[]}
        masterMobile={[]}
      />
    );
    expect(onlyMaster).not.toMatch(/role="tablist"/);
    expect(onlyMaster).toContain("מאסטר");
  });
});

// ======================================================== TERMINOLOGY =======
describe("terminology: קבוצה (not קבוצת אם), צוות (not סגל)", () => {
  const UI_FILES = [
    "app/(app)/page.tsx",
    "app/(app)/groups/page.tsx",
    "app/(app)/groups/learning/[id]/page.tsx",
    "app/(app)/attendance/page.tsx",
    "app/(app)/attendance/overview/page.tsx",
    "app/(app)/admin/employment/page.tsx",
    "components/employment/EmploymentAdminTable.tsx",
    "components/employment/PlacementEditor.tsx",
    "components/calendar/EventEditorDialog.tsx",
    "components/calendar/CalendarCsvImport.tsx",
    "lib/actions/calendar.ts",
    "app/(app)/admin/staff/page.tsx",
    "app/(app)/admin/layout.tsx",
    "app/(app)/admin/page.tsx",
    "app/access-denied/page.tsx",
  ];

  it("no קבוצת אם / קבוצות אם in user-visible UI", () => {
    for (const f of UI_FILES) {
      expect(src(f), f).not.toMatch(/קבוצת אם|קבוצות אם|קבוצת האם|קבוצות האם/);
    }
  });

  it("no סגל in user-visible UI", () => {
    for (const f of UI_FILES) {
      expect(src(f), f).not.toContain("סגל");
    }
  });

  it("learning groups keep their name and get the quiet empty state", () => {
    const groups = src("app/(app)/groups/page.tsx");
    expect(groups).toContain("קבוצות למידה");
    expect(groups).toContain("טרם הוגדרו קבוצות למידה");
    expect(groups).not.toContain("הנהלה יכולה להוסיף");
  });
});

// ================================================ EMPLOYMENT OVERRIDE =======
describe("employment eligibility tri-state override", () => {
  it("effective eligibility precedence: override first, cohort default second", async () => {
    const { effectiveEmploymentEligibility } = await import("@/lib/employment");
    // force eligible wins even for the youngest cohort
    expect(effectiveEmploymentEligibility(false, "eligible")).toBe(true);
    // force ineligible wins even for older cohorts
    expect(effectiveEmploymentEligibility(true, "ineligible")).toBe(false);
    // automatic restores the cohort default
    expect(effectiveEmploymentEligibility(true, "automatic")).toBe(true);
    expect(effectiveEmploymentEligibility(false, "automatic")).toBe(false);
  });

  it("override labels are tri-state Hebrew (never a boolean)", async () => {
    const { EMPLOYMENT_OVERRIDE_LABELS } = await import("@/lib/employment");
    expect(EMPLOYMENT_OVERRIDE_LABELS.automatic).toBe("ברירת מחדל");
    expect(EMPLOYMENT_OVERRIDE_LABELS.eligible).toBe("לאפשר תעסוקה");
    expect(EMPLOYMENT_OVERRIDE_LABELS.ineligible).toBe("לא לאפשר תעסוקה");
  });

  it("the DB function applies the override before the cohort rule", () => {
    const mig = migration("20260923000002_employment_override_and_audit_pagination.sql");
    const fn = mig.slice(
      mig.indexOf("create or replace function public.student_employment_eligible"),
      mig.indexOf("create or replace function public.admin_set_employment_override")
    );
    const overrideIdx = fn.indexOf("student_employment_overrides");
    const cohortIdx = fn.indexOf("hebrew_cohort_rank");
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(cohortIdx).toBeGreaterThan(overrideIdx); // override checked FIRST
  });

  it("set/clear RPC authorizes employment managers and audits the change", () => {
    const mig = migration("20260923000002_employment_override_and_audit_pagination.sql");
    const fn = mig.slice(
      mig.indexOf("create or replace function public.admin_set_employment_override"),
      mig.indexOf("employment_admin_rows — RECREATED")
    );
    expect(fn).toContain("staff_can_manage_employment");
    expect(fn).toContain("insert into public.audit_logs");
    expect(fn).toMatch(/'eligible', 'ineligible', 'automatic'/);
  });

  it("employment admin lists only effectively-eligible students (no זכאות column)", () => {
    const mig = migration("20260923000002_employment_override_and_audit_pagination.sql");
    const fn = mig.slice(
      mig.indexOf("employment_admin_rows("),
      mig.indexOf("student_employment_overview — re-asserted")
    );
    expect(fn).toMatch(/and public\.student_employment_eligible\(s\.id\)/);

    const table = src("components/employment/EmploymentAdminTable.tsx");
    expect(table).not.toContain("זכאות");
    expect(table).not.toContain("employmentEligible");
    expect(table).not.toContain("זכאי/ת");
  });

  it("the student page hosts the override control (managers only, View-As blocked)", () => {
    const studentPage = src("app/(app)/students/[id]/page.tsx");
    expect(studentPage).toContain("canManageOverride");
    expect(studentPage).toMatch(/employment_coordinator/);
    expect(studentPage).toMatch(/!viewAs\.active/);
    const control = src("components/employment/EmploymentOverrideControl.tsx");
    expect(control).toContain("setEmploymentOverrideAction");
    expect(control).toContain("EMPLOYMENT_OVERRIDE_LABELS");
  });

  it("placement creation keeps rejecting ineligible students through the canonical rule", () => {
    const mig22 = migration("20260922000001_student_employment.sql");
    expect(mig22).toMatch(
      /p_student_id is null or not public\.student_employment_eligible\(p_student_id\)/
    );
  });
});

// ================================================== INTAKE CSV FILTERS ======
describe("declaration-of-intent CSV filters", () => {
  it("parses group+major filters; invalid/missing values mean 'all'", async () => {
    const { parseIntakeExportFilters } = await import("@/lib/intake-export");
    const g = "22222222-2222-2222-2222-222222222201";
    const m = "33333333-3333-3333-3333-333333333301";

    const get = (url: string) => new URLSearchParams(url);
    expect(parseIntakeExportFilters(get(""))).toEqual({
      groupId: null,
      majorId: null,
    });
    expect(parseIntakeExportFilters(get(`?groupId=${g}`))).toEqual({
      groupId: g,
      majorId: null,
    });
    expect(parseIntakeExportFilters(get(`?majorId=${m}`))).toEqual({
      groupId: null,
      majorId: m,
    });
    // malformed values are ignored, not trusted
    expect(parseIntakeExportFilters(get("?groupId=not-a-uuid&majorId=x"))).toEqual({
      groupId: null,
      majorId: null,
    });
  });

  it("the server route composes intake + group + major into ONE query", () => {
    const route = src("app/(app)/admin/intake/export/route.ts");
    expect(route).toContain("parseIntakeExportFilters(searchParams)");
    expect(route).toMatch(/\.eq\("intake_id", intakeId\)/);
    expect(route).toMatch(/\.eq\("students\.group_id", filters\.groupId\)/);
    expect(route).toMatch(/\.eq\("major_id", filters\.majorId\)/);
    // BOM + formula-injection protection preserved
    expect(route).toContain("csvWithBom");
    expect(route).toContain("buildCsv");
    // view-as stays blocked
    expect(route).toContain("assertNotViewAs");
  });

  it("the intake manager offers קבוצה and מגמה filters for the export", () => {
    const manager = src("components/admin/IntakeManager.tsx");
    expect(manager).toMatch(/csvGroupId/);
    expect(manager).toMatch(/csvMajorId/);
    expect(manager).toMatch(/groupId=\$\{csvGroupId\}/);
    expect(manager).toMatch(/majorId=\$\{csvMajorId\}/);
  });
});

// ================================================== FORMS FREEZE / IA =======
describe("management IA: forms frozen, structural areas in Settings", () => {
  it("the generic Forms entry is gone from management navigation", () => {
    const layout = src("app/(app)/admin/layout.tsx");
    expect(layout).not.toContain("/admin/forms");
    expect(layout).not.toContain("טפסים");
    // form-engine code stays intact (routes remain for future reactivation)
    expect(src("app/(app)/admin/forms/page.tsx")).toContain("form_definitions");
  });

  it("management navigation labels project intake as הצהרת כוונות", () => {
    const layout = src("app/(app)/admin/layout.tsx");
    expect(layout).toContain("הצהרת כוונות");
    expect(layout).not.toContain("קבלת פרויקטים");
  });

  it("structural admin moved under Settings (super only, never View-As)", () => {
    const settings = src("app/(app)/settings/page.tsx");
    expect(settings).toContain("מבנה החממה");
    for (const href of [
      "/admin/staff",
      "/admin/students",
      "/admin/groups",
      "/admin/majors",
    ]) {
      expect(settings).toContain(href);
    }
    expect(settings).toMatch(/!viewAs\.active/);
    // and they are no longer management-dashboard tabs
    const adminLayout = src("app/(app)/admin/layout.tsx");
    expect(adminLayout).not.toContain('href: "/admin/students"');
    expect(adminLayout).not.toContain('href: "/admin/groups"');
  });

  it("the management overview focuses on operations (no structural stats)", () => {
    const admin = src("app/(app)/admin/page.tsx");
    expect(admin).toContain("הצהרת כוונות");
    expect(admin).toContain("ניהול תעסוקה");
    expect(admin).not.toContain("אנשי סגל בספר");
  });
});

// ============================================ STAFF ROLE SELECTION UI =======
describe("base staff identity is not a selectable role", () => {
  it("role checkboxes exclude 'staff' (implicit/system-owned)", async () => {
    const { SELECTABLE_ROLES, ALL_ROLES } = await import("@/lib/permissions");
    expect(ALL_ROLES).toContain("staff"); // DB stays intact
    expect(SELECTABLE_ROLES).not.toContain("staff");
    expect(SELECTABLE_ROLES).toContain("mentor");
    expect(SELECTABLE_ROLES).toContain("master");
    expect(SELECTABLE_ROLES).toContain("leadership");
    expect(SELECTABLE_ROLES).toContain("super_admin");
  });

  it("the staff admin page renders functional roles only", () => {
    const page = src("app/(app)/admin/staff/page.tsx");
    expect(page).toContain("SELECTABLE_ROLES");
    expect(page).not.toContain("ALL_ROLES.map");
    expect(page).toMatch(/r !== "staff"/);
  });

  it("role chips on Settings hide the implicit staff entry", () => {
    const settings = src("app/(app)/settings/page.tsx");
    expect(settings).toMatch(/r !== "staff"/);
  });
});
