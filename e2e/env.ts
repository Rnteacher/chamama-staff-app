import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * E2E environment bootstrap (imported by playwright.config.ts so the whole
 * run — tests AND the DB-mutation guard — sees the same values).
 *
 * Resolution order (first hit wins, existing process env always wins):
 *   1. process.env (explicit)
 *   2. e2e/.env.e2e  (git-ignored machine-local overrides)
 *   3. derived local defaults from supabase/config.toml:
 *        - E2E_SUPABASE_URL  = http://127.0.0.1:<[api] port>
 *        - E2E_SERVICE_ROLE_KEY = the standard local-stack service key
 *          (the config ships without a jwt_secret override, so the well-known
 *          dev keys apply — the same ones `supabase status` prints)
 *        - ALLOW_E2E_DB_MUTATION = "true" (local stack only; the guard in
 *          test-db-guard.ts still refuses any production-looking target)
 *
 * This keeps `npx playwright test` self-contained: no shell env plumbing,
 * and the app's .env.local (production project) is never read for mutations.
 */

const WELL_KNOWN_LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const WELL_KNOWN_LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function parseDotEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // missing file — nothing to add
  }
  return out;
}

function localApiPort(): string {
  try {
    const config = readFileSync(
      path.resolve(process.cwd(), "supabase", "config.toml"),
      "utf8"
    );
    const apiSection = config.split("[api]")[1] ?? "";
    const port = apiSection.match(/^port\s*=\s*(\d+)/m)?.[1];
    if (port) return port;
  } catch {
    // fall through to the supabase default
  }
  return "54321";
}

function loadE2eEnv(): void {
  const fileEnv = parseDotEnvFile(path.resolve(process.cwd(), "e2e", ".env.e2e"));
  const values: Record<string, string> = {
    E2E_SUPABASE_URL: `http://127.0.0.1:${localApiPort()}`,
    E2E_SERVICE_ROLE_KEY: WELL_KNOWN_LOCAL_SERVICE_KEY,
    E2E_SUPABASE_ANON_KEY: WELL_KNOWN_LOCAL_ANON_KEY,
    ALLOW_E2E_DB_MUTATION: "true",
  };
  for (const [key, value] of Object.entries(values)) {
    if (fileEnv[key] !== undefined) {
      process.env[key] = fileEnv[key];
    } else if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  // optional machine-local overrides that are NOT derived
  if (existsSync(path.resolve(process.cwd(), "e2e", ".env.e2e"))) {
    for (const [key, value] of Object.entries(fileEnv)) {
      if (!(key in values)) process.env[key] = value;
    }
  }
}

loadE2eEnv();
