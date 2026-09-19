import { timingSafeEqual } from "node:crypto";

export interface CronAuthResult {
  ok: boolean;
  /** 200 = authorized, 500 = server misconfiguration (secret missing), 401 = caller unauthorized */
  status: 200 | 500 | 401;
}

/**
 * Constant-time verification of the scheduler's Bearer secret.
 *
 * The scheduler (Supabase Cron → pg_net) must send:
 *   Authorization: Bearer <CRON_SECRET>
 * where CRON_SECRET is a server-only environment variable — never exposed
 * to the browser, never logged, never in source control.
 */
export function verifyCronAuth(
  request: Request,
  configuredSecret: string | undefined
): CronAuthResult {
  if (!configuredSecret) {
    // endpoint cannot be safely used without its secret configured
    return { ok: false, status: 500 };
  }
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${configuredSecret}`;
  const given = Buffer.from(header, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  const ok =
    given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf);
  return ok ? { ok: true, status: 200 } : { ok: false, status: 401 };
}
