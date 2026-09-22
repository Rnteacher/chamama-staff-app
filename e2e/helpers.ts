import { expect, test, type Page, type Cookie } from "@playwright/test";

export const SKIP = !process.env.E2E_ENABLED;

export const USERS = {
  admin: { email: "ronen@chamama.example", password: "Chamama2026!" },
  staff: { email: "tom@chamama.example", password: "Chamama2026!" },
  mentor: { email: "michal@chamama.example", password: "Chamama2026!" },
  master: { email: "naama@chamama.example", password: "Chamama2026!" },
  deactivated: { email: "dana@chamama.example", password: "Chamama2026!" },
  coordinator: { email: "itay@chamama.example", password: "Chamama2026!" },
};

/**
 * Runtime availability of email login on the app under test, probed at most
 * once per worker. When the app intentionally disables it
 * (NEXT_PUBLIC_ENABLE_EMAIL_LOGIN != true — e.g. the default local config),
 * authenticated specs must SKIP with a clear reason instead of failing, so
 * the suite stays usable.
 */
let emailAuthProbe: { available: boolean; reason: string } | null = null;

async function probeEmailAuth(page: Page): Promise<{ available: boolean; reason: string }> {
  if (emailAuthProbe) return emailAuthProbe;
  try {
    await page.goto("/login");
    const toggleVisible = await page
      .getByText("כניסה לבדיקות באמצעות אימייל")
      .isVisible()
      .catch(() => false);
    emailAuthProbe = toggleVisible
      ? { available: true, reason: "" }
      : {
          available: false,
          reason:
            "email login is intentionally unavailable on the app under test (NEXT_PUBLIC_ENABLE_EMAIL_LOGIN != true) — authenticated test skipped",
        };
  } catch (err) {
    emailAuthProbe = {
      available: false,
      reason: `login page unreachable (${String(err)}) — authenticated test skipped`,
    };
  }
  return emailAuthProbe;
}

/**
 * Skips the currently running test (with a clear reason) when email login is
 * not available. Safe to call from hooks and tests.
 */
export async function requireEmailAuth(page: Page): Promise<void> {
  const probe = await probeEmailAuth(page);
  if (!probe.available) test.info().skip(true, probe.reason);
}

/**
 * Per-worker session cache: the first login for a user performs the form
 * flow and stores the auth cookies; every subsequent login in the same
 * worker replays them instead of hammering the local auth endpoint's
 * password-grant rate limits (the suite signs in many accounts back-to-back).
 */
const sessionCookies = new Map<string, Cookie[]>();

export async function login(page: Page, user: { email: string; password: string }) {
  await requireEmailAuth(page);
  const cached = sessionCookies.get(user.email);
  if (cached && cached.length > 0) {
    await page.context().addCookies(cached);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    return;
  }
  await page.goto("/login");
  await page.getByText("כניסה לבדיקות באמצעות אימייל").click();
  await page.getByLabel("אימייל").fill(user.email);
  await page.getByLabel("סיסמה").fill(user.password);
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  sessionCookies.set(user.email, await page.context().cookies());
}

export async function logout(page: Page) {
  // signing out revokes the session server-side — drop any cached cookies
  // so the next login performs a fresh form flow
  sessionCookies.clear();
  await page.goto("/settings");
  await page.getByRole("button", { name: "התנתקות" }).click();
  await expect(page).toHaveURL(/\/login/);
}
