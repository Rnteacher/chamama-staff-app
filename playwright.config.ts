import { defineConfig, devices } from "@playwright/test";
import "./e2e/env";

/**
 * E2E tests. They require a running stack:
 *   1. Local Supabase (supabase start) with migrations + seed applied
 *   2. App dev/prod server with NEXT_PUBLIC_ENABLE_EMAIL_LOGIN=true
 *   3. E2E_ENABLED=1 npm run e2e
 * Without E2E_ENABLED the specs skip themselves.
 *
 * The DB-mutation guard's env (E2E_SUPABASE_URL / E2E_SERVICE_ROLE_KEY /
 * ALLOW_E2E_DB_MUTATION) is bootstrapped from supabase/config.toml by
 * e2e/env.ts — no shell plumbing needed.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  // ONE worker: mobile + desktop projects share a single seeded local DB, so
  // concurrent workers corrupt each other's data (attendance rows, intake
  // windows, registration windows). Everything runs sequentially instead.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    locale: "he-IL",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
