import { test, expect, type Page } from "@playwright/test";
import { SKIP, USERS, login } from "./helpers";
import { getE2eAdminClient } from "./test-db-guard";

/**
 * Bottom-nav unread badge == /updates "לא נקראו": hidden at zero, exact
 * count otherwise, and anchored to the Updates icon on every viewport.
 */
test.skip(SKIP, "E2E requires a running local stack (see e2e/helpers.ts)");

const badge = (page: Page) =>
  page.locator('nav[aria-label="ניווט ראשי"] [data-unread-badge]');
const unreadTab = (page: Page) => page.getByRole("button", { name: /^לא נקראו/ });

function actionDone(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"])
  );
}

async function flip(page: Page, label: "סמן כנקרא" | "סמן כלא נקרא") {
  const done = actionDone(page);
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await done;
}

async function expectBadge(page: Page, n: number) {
  if (n === 0) {
    await expect(badge(page)).toHaveCount(0);
    await expect(unreadTab(page)).toHaveText("לא נקראו");
  } else {
    await expect(badge(page)).toHaveText(String(n));
    await expect(unreadTab(page)).toHaveText(`לא נקראו${n}`);
  }
}

test("badge tracks /updates unread exactly: 0 → 1 → 3 → 0, survives reload", async ({ page }) => {
  await login(page, USERS.master);
  await page.goto("/updates");

  // start from zero unread
  const markAll = page.getByRole("button", { name: /סמן הכל כנקרא/ });
  if (await markAll.isVisible().catch(() => false)) {
    const done = actionDone(page);
    await markAll.click();
    await done;
  }
  await expectBadge(page, 0);
  await page.reload();
  await expectBadge(page, 0);

  // 1 unread
  await flip(page, "סמן כלא נקרא");
  await expectBadge(page, 1);

  // 3 unread
  await flip(page, "סמן כלא נקרא");
  await flip(page, "סמן כלא נקרא");
  await expectBadge(page, 3);
  await page.getByRole("button", { name: /^לא נקראו/ }).click();
  await expect(page.getByRole("button", { name: "סמן כנקרא", exact: true })).toHaveCount(3);

  // mark them read one by one — the last one clears the badge
  await flip(page, "סמן כנקרא");
  await flip(page, "סמן כנקרא");
  await expectBadge(page, 1);
  await flip(page, "סמן כנקרא");
  await expectBadge(page, 0);
  await page.reload();
  await expectBadge(page, 0);
  // the filter is server-side (?filter=unread) and survives the reload
  await expect(page.getByText("כל העדכונים הרלוונטיים אליכם נקראו.")).toBeVisible();

  // marking unread again brings it back; then restore
  await page.getByRole("button", { name: "הכל", exact: true }).click();
  await page.waitForURL((u) => !u.search.includes("filter="));
  await flip(page, "סמן כלא נקרא");
  await expectBadge(page, 1);
  await page.reload();
  await expectBadge(page, 1);
  await flip(page, "סמן כנקרא");
  await expectBadge(page, 0);
});

test("badge is attached to the Updates icon (1 and 2+ digits)", async ({ page }) => {
  await login(page, USERS.master);
  await page.goto("/updates");
  await flip(page, "סמן כלא נקרא");
  await expect(badge(page)).toBeVisible();

  const icon = page.locator('nav[aria-label="ניווט ראשי"] [data-nav-icon="/updates"] svg');
  const measure = async () => {
    const b = (await badge(page).boundingBox())!;
    const i = (await icon.boundingBox())!;
    return { b, i };
  };

  const one = await measure();
  // the badge overlaps / touches the icon's upper corner (within a few px)
  const cx = one.b.x + one.b.width / 2;
  const cy = one.b.y + one.b.height / 2;
  expect(cx).toBeGreaterThan(one.i.x - 14);
  expect(cx).toBeLessThan(one.i.x + one.i.width + 14);
  expect(cy).toBeGreaterThan(one.i.y - 14);
  expect(cy).toBeLessThan(one.i.y + one.i.height / 2);

  // 2+ digits: same anchor, grows away from the icon, no layout shift
  const linkBefore = (await page.locator('nav[aria-label="ניווט ראשי"] a[href="/updates"]').boundingBox())!;
  await badge(page).evaluate((el) => (el.textContent = "99+"));
  const wide = await measure();
  expect(Math.abs(wide.b.x + wide.b.width - (one.b.x + one.b.width))).toBeLessThan(1.5);
  expect(Math.abs(wide.b.y - one.b.y)).toBeLessThan(1.5);
  expect(wide.i).toEqual(one.i);
  const linkAfter = (await page.locator('nav[aria-label="ניווט ראשי"] a[href="/updates"]').boundingBox())!;
  expect(linkAfter).toEqual(linkBefore);

  // restore
  await page.reload();
  await flip(page, "סמן כנקרא");
  await expect(badge(page)).toHaveCount(0);
});

test("250 unread: badge exact, bounded first page, load more exposes all, mark-all clears all", async ({ page }) => {
  const admin = getE2eAdminClient();
  const MARK = "e2e-paging-";
  const STUDENT = "44444444-4444-4444-4444-444444444409";
  const AUTHOR = "11111111-1111-1111-1111-111111111101";
  const cleanup = async () => {
    const { error } = await admin.from("student_messages").delete().like("body", `${MARK}%`);
    expect(error).toBeNull();
  };
  await cleanup();

  await login(page, USERS.master);
  await page.goto("/updates");
  const markAll = page.getByRole("button", { name: /סמן הכל כנקרא/ });
  if (await markAll.isVisible().catch(() => false)) {
    const done = actionDone(page);
    await markAll.click();
    await done;
  }
  await expectBadge(page, 0);

  // 250 new general-visible updates → 250 unread for this staff member
  const now = Date.now();
  const { error } = await admin.from("student_messages").insert(
    Array.from({ length: 250 }, (_, i) => ({
      student_id: STUDENT,
      author_staff_id: AUTHOR,
      body: `${MARK}${i}`,
      is_general_visible: true,
      created_at: new Date(now - (i + 1) * 1000).toISOString(),
    }))
  );
  expect(error).toBeNull();

  try {
    await page.goto("/updates?filter=unread");
    // the badge counts ALL unread (displayed capped as 99+; exact in its label)
    await expect(badge(page)).toHaveText("99+");
    await expect(badge(page)).toHaveAttribute("aria-label", "250 עדכונים שלא נקראו");
    await expect(unreadTab(page)).toHaveText("לא נקראו250");

    // first page is bounded; "טען עוד" pages through the rest
    const unreadItems = page.getByRole("button", { name: "סמן כנקרא", exact: true });
    await expect(unreadItems).toHaveCount(50);
    const more = page.getByRole("button", { name: "טען עוד" });
    for (const expected of [100, 150, 200, 250]) {
      await more.click();
      await expect(unreadItems).toHaveCount(expected);
    }
    await expect(more).toHaveCount(0);

    // mark-all marks the whole canonical set — with only the FIRST page loaded
    await page.reload();
    await expect(unreadItems).toHaveCount(50);
    const done = actionDone(page);
    await page.getByRole("button", { name: "סמן הכל כנקרא (250)" }).click();
    await done;
    await expectBadge(page, 0);
    await page.reload();
    await expectBadge(page, 0);
    await expect(page.getByText("כל העדכונים הרלוונטיים אליכם נקראו.")).toBeVisible();
  } finally {
    await cleanup();
  }
});
