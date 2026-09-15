import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests. They require a running stack:
 *   1. Local Supabase (supabase start) with migrations + seed applied
 *   2. App dev/prod server with NEXT_PUBLIC_ENABLE_EMAIL_LOGIN=true
 *   3. E2E_ENABLED=1 npm run e2e
 * Without E2E_ENABLED the specs skip themselves.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
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
  ],
});
