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
 * Per-worker session cache. The FIRST login for a user performs the form
 * flow; every later login replays the cached Supabase auth cookies instead
 * of hitting the local auth endpoint's password-grant rate limits (the suite
 * signs in many accounts back-to-back).
 *
 * Only `sb-*` auth cookies are cached — app cookies (View-As, etc.) must
 * never leak into a replayed session. A replay whose session was revoked
 * server-side (a real sign-out) self-heals: the flow falls through to a
 * fresh form login.
 */
const sessionCookies = new Map<string, Cookie[]>();

function authCookiesOnly(cookies: Cookie[]): Cookie[] {
  return cookies.filter((c) => c.name.startsWith("sb-"));
}

export async function login(page: Page, user: { email: string; password: string }) {
  await requireEmailAuth(page);
  const cached = sessionCookies.get(user.email);
  if (cached && cached.length > 0) {
    await page.context().clearCookies();
    await page.context().addCookies(cached);
    await page.goto("/");
    if (!page.url().includes("/login")) {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      return;
    }
    // cached session was revoked server-side — fall through to a fresh login
  }
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByText("כניסה לבדיקות באמצעות אימייל").click();
  await page.getByLabel("אימייל").fill(user.email);
  await page.getByLabel("סיסמה").fill(user.password);
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  sessionCookies.set(user.email, authCookiesOnly(await page.context().cookies()));
}

/**
 * Real sign-out through the app's own UI (this exercises the sign-out
 * server action and the /login redirect). The session cache is NOT cleared:
 * login() self-heals over a revoked cached session, so no extra password
 * grants are burned.
 */
export async function logout(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "התנתקות" }).click();
  await expect(page).toHaveURL(/\/login/);
}
