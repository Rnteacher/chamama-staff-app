import { createHash } from "node:crypto";

/**
 * CSV export helpers. Safe escaping, BOM, formula-injection protection.
 */

/** Escape a cell for safe CSV output. */
function escapeCell(value: string): string {
  // formula injection: prefix =, +, -, @ with a tab or single quote
  const safe =
    /^[=+\-@]/.test(value) ? `'${value}` : value;
  // wrap in double quotes if the value contains comma, quote, or newline
  if (/["\n\r,]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Build a CSV string from headers + rows.
 * All cells are escaped; formula injection is mitigated.
 */
export function buildCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(","));
  }
  return lines.join("\r\n");
}

/** UTF-8 BOM for Excel Hebrew compatibility. */
export function csvWithBom(csv: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, "utf8")]);
}
