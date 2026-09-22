import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Desktop responsive layout regression tests (layout pass only — no behavior
 * change): the app shell must open up to desktop width on lg+ while the
 * mobile flow stays intact.
 */

const src = (p: string) =>
  readFileSync(path.resolve(__dirname, "../../src", p), "utf8");

// ================================================================ 1. SHELL ==
describe("1. app shell width", () => {
  const layout = src("app/(app)/layout.tsx");

  it("main content area is a wide desktop canvas (max-w-[1600px]), not max-w-3xl", () => {
    expect(layout).toContain("max-w-[1600px]");
    expect(layout).not.toContain("max-w-3xl");
  });

  it("mobile padding + bottom-nav clearance are preserved (px-4 pb-28)", () => {
    const main = layout.slice(layout.indexOf("<main"), layout.indexOf("</main>"));
    expect(main).toContain("px-4");
    expect(main).toContain("pb-28");
    expect(main).toContain("pt-4");
    expect(main).toContain("lg:px-8");
  });

  it("header inner container also opens to desktop width", () => {
    const header = layout.slice(layout.indexOf("<header"), layout.indexOf("</header>"));
    expect(header).toContain("max-w-[1600px]");
  });
});

// ====================================================== 2. NAV DOESN'T CAP ==
describe("2. bottom navigation does not constrain content", () => {
  const nav = src("components/BottomNav.tsx");

  it("bottom nav is a fixed overlay with its own width (behavior unchanged)", () => {
    expect(nav).toContain("fixed inset-x-0 bottom-0");
    expect(nav).toContain("max-w-3xl");
  });
});

// ============================================================= 3. HOME ======
describe("3. desktop home composition", () => {
  const home = src("app/(app)/page.tsx");

  it("updates are NOT part of home (updates live on /updates)", () => {
    expect(home).not.toContain('aria-labelledby="unread-heading"');
  });

  it("the global student-search entry is visible on every viewport", () => {
    const linkBlock = home.slice(
      home.indexOf('href="/search"'),
      home.indexOf("</Link>", home.indexOf('href="/search"'))
    );
    expect(linkBlock).not.toContain("lg:hidden");
  });

  it("relationship-scoped student tables remain the lg-only dashboard", () => {
    const panel = src("components/home/HomeStudentsPanel.tsx");
    expect(panel).toMatch(/className="hidden lg:block"/);
    expect(panel).toMatch(/className="flex flex-col gap-2 lg:hidden"/);
  });
});

// ====================================================== 4. STUDENT TABLE ====
describe("4. student data table is a desktop-first surface", () => {
  const table = src("components/tables/StudentDataTable.tsx");

  it("keeps a horizontal-scroll floor for narrow screens", () => {
    expect(table).toMatch(/min-w-\[\d+px\]/);
  });

  it("cells keep natural column widths (no squeezed wrapping) on desktop", () => {
    expect(table).toMatch(/whitespace-nowrap text-right/);
  });

  it("search input grows into a proper toolbar field on desktop", () => {
    expect(table).toMatch(/sm:w-56 lg:w-72/);
    // still exactly one student search input
    expect(table.match(/type="search"/g)).toHaveLength(1);
  });
});

// ====================================================== 5. STUDENT PAGE =====
describe("5. student page desktop composition", () => {
  const page = src("app/(app)/students/[id]/page.tsx");

  it("uses a 2fr/1fr responsive grid on lg", () => {
    expect(page).toContain("lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]");
    expect(page).toContain("lg:items-start");
  });

  it("summary and meetings land in the secondary column", () => {
    expect(page).toContain("lg:col-start-2 lg:row-start-1");
    expect(page).toContain("lg:col-start-2 lg:row-start-2");
  });

  it("feed spans the main column across both rows", () => {
    expect(page).toContain("lg:col-start-1 lg:row-start-1 lg:row-span-2");
  });

  it("mobile order preserved: summary(1) → meetings(2) → feed(3)", () => {
    const o1 = page.indexOf("order-1");
    const o2 = page.indexOf("order-2");
    const o3 = page.indexOf("order-3");
    expect(o1).toBeGreaterThan(-1);
    expect(o2).toBeGreaterThan(o1);
    expect(o3).toBeGreaterThan(o2);
  });
});

// ============================================================= 6. ADMIN =====
describe("6. admin screens use desktop width", () => {
  it("activity log rows become aligned desktop columns on lg", () => {
    const admin = src("app/(app)/admin/page.tsx");
    expect(admin).toMatch(/lg:grid-cols-\[10rem_minmax\(8rem,auto\)_1fr_auto\]/);
  });

  it("intake window rows keep actions on one line on lg", () => {
    const intake = src("components/admin/IntakeManager.tsx");
    expect(intake).toMatch(/lg:flex-nowrap/);
    expect(intake).toMatch(/lg:max-w-\[420px\]/); // intent text gets room
    expect(intake).toMatch(/min-w-\[900px\]/); // submissions table stays wide
  });

  it("management card lists go two-up on lg instead of one stretched column", () => {
    for (const p of [
      "app/(app)/admin/students/page.tsx",
      "app/(app)/admin/staff/page.tsx",
      "app/(app)/admin/groups/page.tsx",
      "app/(app)/admin/majors/page.tsx",
    ]) {
      expect(src(p)).toMatch(/lg:grid lg:grid-cols-2/);
    }
  });
});

// ================================================ 7. READABLE TEXT WIDTHS ===
describe("7. readable line lengths preserved", () => {
  it("/updates feed is capped to a prose-friendly width", () => {
    expect(src("components/updates/UpdatesList.tsx")).toContain("max-w-4xl");
  });

  it("composer CTA stops bleeding past its desktop grid column", () => {
    expect(src("components/Composer.tsx")).toContain("lg:mx-0 lg:px-0");
  });

  it("group/major/search student lists go two-up on lg (not edge-to-edge rows)", () => {
    for (const p of [
      "app/(app)/groups/page.tsx",
      "app/(app)/majors/page.tsx",
      "app/(app)/groups/[id]/page.tsx",
      "app/(app)/majors/[id]/page.tsx",
      "components/SearchClient.tsx",
    ]) {
      expect(src(p)).toMatch(/lg:grid lg:grid-cols-2/);
    }
  });
});
