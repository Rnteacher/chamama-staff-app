import { createHash } from "node:crypto";

/**
 * Canonical intake-token hashing — the SINGLE source of truth used by the
 * admin action. The database side (supabase/migrations/20260917000001)
 * computes the identical value with:
 *   encode(sha256(convert_to(<raw token>, 'UTF8')), 'hex')
 * (lowercase hex, sha256 over the exact UTF-8 bytes of the raw token).
 * Raw tokens are NEVER stored in the database.
 */
export function hashIntakeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type IntakeStatus =
  | "open"
  | "not_open"
  | "closed"
  | "invalid"
  | "error";

export interface IntakeOverview {
  status: IntakeStatus;
  title?: string;
  opens_at?: string;
  closes_at?: string;
  groups?: { id: string; name: string }[];
}

/**
 * Maps the RPC result to a strict state. An RPC failure (null data) or an
 * unexpected server-side error is a TECHNICAL error state — it must never be
 * presented to the user as an "invalid link".
 */
export function resolveIntakeState(data: unknown): IntakeOverview {
  const raw = (data ?? {}) as Partial<IntakeOverview> & { status?: string };
  const status: IntakeStatus =
    raw.status === "open" ||
    raw.status === "not_open" ||
    raw.status === "closed" ||
    raw.status === "invalid"
      ? raw.status
      : // null data (RPC error) or unknown status → technical failure
        "error";
  return {
    status,
    title: typeof raw.title === "string" ? raw.title : undefined,
    opens_at: typeof raw.opens_at === "string" ? raw.opens_at : undefined,
    closes_at: typeof raw.closes_at === "string" ? raw.closes_at : undefined,
    groups: Array.isArray(raw.groups) ? raw.groups : undefined,
  };
}

/** Build the public intake URL for a raw token. */
export function buildIntakeUrl(origin: string, token: string): string {
  return `${origin}/intake/${token}`;
}
