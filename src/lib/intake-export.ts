/**
 * Server-side filter parsing for the declaration-of-intent CSV export
 * (/admin/intake/export). The selected intake window is REQUIRED and stays
 * the primary scope; group + major filters compose with it (and with each
 * other) and are always enforced by the export route itself — never only in
 * the browser. Invalid values are ignored (treated as "all") rather than
 * trusted.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IntakeExportFilters {
  /** null = all groups */
  groupId: string | null;
  /** null = all majors */
  majorId: string | null;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

/**
 * Read { groupId, majorId } from any URLSearchParams-like source.
 * "all" / missing / malformed → null (the full scope for that dimension).
 */
export function parseIntakeExportFilters(params: {
  get(name: string): string | null | undefined;
}): IntakeExportFilters {
  const groupId = uuidOrNull(params.get("groupId"));
  const majorId = uuidOrNull(params.get("majorId"));
  return { groupId, majorId };
}

/** Human-readable filter summary (only used for the filename context). */
export function describeIntakeExportFilters(f: IntakeExportFilters): string {
  const parts: string[] = [];
  if (f.groupId) parts.push(`group=${f.groupId}`);
  if (f.majorId) parts.push(`major=${f.majorId}`);
  return parts.length > 0 ? parts.join("&") : "all";
}
