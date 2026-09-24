import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  employmentApplies,
  hasEmploymentHistory,
  type EmploymentOverviewData,
} from "@/lib/employment";

/**
 * Small corrections pass: unread nav badge (count + anchoring) and
 * employment visibility on the student page.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => undefined }),
}));
// the add action's server action is not exercised by render tests
vi.mock("@/lib/actions/employment", () => ({
  setEmploymentOverrideAction: async () => ({ ok: true }),
}));
vi.mock("@/lib/actions/messages", () => ({
  loadUpdatesPageAction: async () => ({ ok: true, items: [], nextCursor: null }),
  markAllUpdatesReadAction: async () => ({ ok: true }),
  markMessagesReadAction: async () => ({ ok: true }),
  markMessagesUnreadAction: async () => ({ ok: true }),
}));

const migration = (name: string) =>
  readFileSync(path.resolve(__dirname, "../../supabase/migrations", name), "utf8");
const src = (p: string) => readFileSync(path.resolve(__dirname, "../../src", p), "utf8");

// ================================================================ BADGE =====
describe("unread nav badge", () => {
  async function nav(totalUnread: number) {
    const BottomNav = (await import("@/components/BottomNav")).default;
    return renderToStaticMarkup(<BottomNav totalUnread={totalUnread} showCalendar={false} />);
  }
  const badgeText = (html: string) =>
    html.match(/data-unread-badge=""[^>]*>([^<]*)<\/span>/)?.[1] ?? null;

  it("0 unread → no badge at all (not 0, not 1)", async () => {
    const html = await nav(0);
    expect(html).not.toContain("data-unread-badge");
    expect(html).not.toContain("עדכונים שלא נקראו");
  });

  it("1 unread → 1; 3 unread → 3; 120 → 99+", async () => {
    expect(badgeText(await nav(1))).toBe("1");
    expect(badgeText(await nav(3))).toBe("3");
    expect(badgeText(await nav(120))).toBe("99+");
  });

  it("marking the last unread read (count 1 → 0) removes the badge", async () => {
    expect(badgeText(await nav(1))).toBe("1");
    expect(badgeText(await nav(0))).toBeNull();
  });

  it("is anchored to the Updates ICON wrapper, not to the whole nav cell", async () => {
    const html = await nav(3);
    // the badge sits inside the relative wrapper that holds the bell icon
    const wrapper = html.match(
      /<span class="relative inline-flex" data-nav-icon="\/updates">([\s\S]*?)<\/span><span/
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper![1]).toContain("<svg");
    expect(wrapper![1]).toContain("data-unread-badge");
    // no cell-relative offsets any more (the old "top-1 left-4" drifted on desktop)
    expect(html).not.toMatch(/data-unread-badge=""[^>]*class="[^"]*\bleft-4\b/);
    // right edge pinned inside the icon: extra digits grow away from the icon
    expect(src("components/BottomNav.tsx")).toContain("right-[calc(100%-0.625rem)]");
  });

  it("one canonical source: the count and the /updates pages share staff_visible_messages()", () => {
    const m = migration("20260923000006_unread_count_matches_updates.sql");
    const fn = (name: string) => {
      const i = m.indexOf(`function public.${name}`);
      return m.slice(i, m.indexOf("$$;", m.indexOf("as $$", i)));
    };
    expect(fn("student_unread_counts")).toContain("from public.staff_visible_messages() v");
    expect(fn("staff_message_updates_page")).toContain("from public.staff_visible_messages() sv");
    expect(fn("staff_mark_all_updates_read")).toContain("from public.staff_visible_messages() v");
    // soft-deleted messages are excluded in the shared definition
    expect(fn("staff_visible_messages")).toContain("m.deleted_at is null");
    // pages are bounded server-side
    expect(fn("staff_message_updates_page")).toContain("least(coalesce(p_limit, 51), 101)");
    // the UI does not paper over the count
    expect(src("components/BottomNav.tsx")).not.toMatch(/Math\.max\(\s*1/);
  });
});

// ============================================================ /updates ======
describe("/updates list — server-side paging", () => {
  const item = (i: number, read: boolean) => ({
    message_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    student_id: "s1", student_first_name: "א", student_last_name: "ב",
    author_name: "צוות", body: `עדכון ${i}`,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, 0) - i * 60_000).toISOString(),
    read,
  });

  async function list(props: Record<string, unknown>) {
    const UpdatesList = (await import("@/components/updates/UpdatesList")).default;
    return renderToStaticMarkup(
      <UpdatesList filter="unread" initialItems={[]} initialCursor={null} totalUnread={0} {...props} />
    );
  }

  it("renders one bounded page and offers 'טען עוד' when the server has more", async () => {
    const items = Array.from({ length: 50 }, (_, i) => item(i, false));
    const html = await list({
      initialItems: items,
      initialCursor: { createdAt: items[49].created_at, id: items[49].message_id },
      totalUnread: 250,
    });
    expect(html.match(/<li>/g)?.length).toBe(50);
    expect(html).toContain("טען עוד");
  });

  it("tab and mark-all use the canonical total (250), not the loaded page", async () => {
    const html = await list({ initialItems: [item(1, false)], totalUnread: 250 });
    expect(html).toContain("סמן הכל כנקרא (250)");
    expect(html).toMatch(/לא נקראו<span[^>]*>250<\/span>/);
  });

  it("0 unread → no mark-all, no tab count, empty-state text", async () => {
    const html = await list({ totalUnread: 0 });
    expect(html).not.toContain("סמן הכל כנקרא");
    expect(html).toContain("כל העדכונים הרלוונטיים אליכם נקראו.");
    expect(html).not.toContain("טען עוד");
  });

  it("mark-all goes to the server action for the whole unread set", () => {
    const listSrc = src("components/updates/UpdatesList.tsx");
    expect(listSrc).toContain("markAllUpdatesReadAction()");
    expect(listSrc).not.toContain("markMessagesReadAction({ messageIds: unreadIds })");
    const page = src("app/(app)/updates/page.tsx");
    expect(page).toContain("fetchUpdatesPage(filter, null)");
    expect(page).not.toContain("staff_message_updates\", { p_limit");
  });
});

// ========================================================== EMPLOYMENT =====
describe("employment section visibility (student page)", () => {
  const base: EmploymentOverviewData = {
    eligible: false,
    override: null,
    cohort_note: "קבוצת השנתון הצעירה — לא נכללת בתוכנית התעסוקה",
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

  it("youngest cohort + automatic (canonical eligible=false, no records) → hidden", () => {
    expect(employmentApplies(base)).toBe(false);
  });

  it("youngest cohort + force eligible (canonical eligible=true) → shown", () => {
    expect(employmentApplies({ ...base, eligible: true, override: "eligible", cohort_note: null })).toBe(true);
  });

  it("older cohort + automatic eligible → shown", () => {
    expect(employmentApplies({ ...base, eligible: true, cohort_note: null })).toBe(true);
  });

  it("older cohort + legacy force ineligible → canonical eligible=true → shown", () => {
    // the database reports eligible=true for every older cohort (000008)
    expect(
      employmentApplies({ ...base, eligible: true, override: "ineligible", cohort_note: null })
    ).toBe(true);
  });

  it("existing placement / hours stay reachable even when not eligible", () => {
    expect(hasEmploymentHistory({ ...base, placement })).toBe(true);
    expect(hasEmploymentHistory({ ...base, total_minutes: 30 })).toBe(true);
    expect(employmentApplies({ ...base, placement, total_minutes: 12000 })).toBe(true);
  });

  it("renders NOTHING for a default-ineligible student — for staff AND for managers", async () => {
    const Card = (await import("@/components/employment/StudentEmploymentCard")).default;
    expect(renderToStaticMarkup(<Card data={base} studentId="s1" />)).toBe("");
  });

  it("managers add the student from OUTSIDE the card (force-eligible override)", async () => {
    const page = src("app/(app)/students/[id]/page.tsx");
    expect(page).toContain("<AddToEmploymentButton");
    expect(page).toContain("!employmentApplies(employment)");
    const btn = src("components/employment/AddToEmploymentButton.tsx");
    expect(btn).toContain('fd.set("override", "eligible")');
    expect(btn).toContain("הוספה לתעסוקה");
    const Button = (await import("@/components/employment/AddToEmploymentButton")).default;
    const html = renderToStaticMarkup(<Button studentId="s1" />);
    expect(html).toContain("הוספה לתעסוקה");
    expect(html).not.toContain("תעסוקה</h2>");
  });

  it("the card decides from the canonical flag only — no cohort names in React", () => {
    const card = src("components/employment/StudentEmploymentCard.tsx");
    expect(card).toContain("employmentApplies(");
    expect(card).not.toContain("ולריאן");
    expect(card).not.toContain("hebrew_cohort_rank");
    expect(card).not.toMatch(/cohort_note\s*\?/);
  });
});
