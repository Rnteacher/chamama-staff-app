/**
 * CALENDAR CSV IMPORT — pure parse/normalize layer (unit-test friendly).
 *
 * The NAME→ID audience resolution happens SERVER-SIDE (in the server action);
 * this module only tokenizes, normalizes human values and surfaces
 * row-specific format errors. The canonical event validation still happens
 * in calendarEventSchema + admin_upsert_calendar_event — the CSV path never
 * creates a weaker parallel one.
 *
 * Headers accept Hebrew or English (bilingual aliases, case/space
 * insensitive). Audience targets are ';'-separated and may be prefixed to
 * disambiguate; unprefixed targets are resolved by name server-side.
 */

export type AudienceToken =
  | { kind: "everyone"; target: string }
  | { kind: "staff_only"; target: string }
  | { kind: "home_group"; target: string }
  | { kind: "major"; target: string }
  | { kind: "learning_group"; target: string }
  | { kind: "staff_member"; target: string }
  | { kind: "auto"; target: string };

export interface CalendarCsvRow {
  line: number; // 1-based CSV line (headers = line 1)
  title: string;
  description: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  /** normalized value; unparseable input additionally yields a row error */
  isAllDay: boolean;
  /** normalized value; unparseable input additionally yields a row error */
  recurrence: "none" | "weekly" | "monthly";
  recurrenceUntil: string;
  audiences: AudienceToken[];
  errors: string[]; // row-specific format errors (Hebrew, user-facing)
}

export interface ParsedCalendarCsv {
  rows: CalendarCsvRow[];
  /** recognized header columns — missing required ones are reported */
  foundHeaders: string[];
  fatal?: string; // whole-file problem (not parseable / no header row)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** RFC4180-style CSV: quoted fields, "" escapes, CR/LF/CRLF, UTF-8 BOM. */
export function parseCsvRecords(raw: string): string[][] {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ").replace(/["']/g, "");
}

const HEADER_ALIASES: Record<string, string[]> = {
  title: ["כותרת", "title", "נושא"],
  startDate: ["תאריך התחלה", "start date", "start_date", "מתאריך"],
  startTime: ["שעת התחלה", "start time", "start_time", "משעה"],
  endDate: ["תאריך סיום", "end date", "end_date", "עד תאריך"],
  endTime: ["שעת סיום", "end time", "end_time", "עד שעה"],
  isAllDay: ["כל היום", "all day", "all-day", "all_day"],
  recurrence: ["חזרה", "recurrence"],
  recurrenceUntil: ["חזרה עד", "recurrence until", "recurrence_until", "עד"],
  audiences: ["קהל יעד", "קהלי יעד", "audiences", "audience"],
  description: ["תיאור", "description"],
};

function matchHeader(cell: string): string | null {
  const n = normHeader(cell);
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((a) => normHeader(a) === n)) return key;
  }
  return null;
}

function parseAllDay(v: string): boolean | null {
  const n = normHeader(v);
  if (n === "") return false;
  if (["כן", "true", "1", "x", "yes", "y"].includes(n)) return true;
  if (["לא", "false", "0", "no", "n"].includes(n)) return false;
  return null;
}

function parseRecurrence(v: string): "none" | "weekly" | "monthly" | null {
  const n = normHeader(v);
  if (n === "") return "none";
  if (["none", "ללא", "חד פעמי", "חד-פעמי", "חדפעמי", "one time", "one-time"].includes(n)) return "none";
  if (["weekly", "שבועי"].includes(n)) return "weekly";
  if (["monthly", "חודשי"].includes(n)) return "monthly";
  return null;
}

/**
 * Split the audiences cell into tokens. ';'-separated. Optional explicit
 * prefix (Hebrew or English) — unprefixed targets are resolved by name
 * server-side ('auto').
 */
export function parseAudienceCell(cell: string): AudienceToken[] {
  const out: AudienceToken[] = [];
  for (const part of cell.split(/;/)) {
    const t = part.trim();
    if (t === "") continue;
    const colon = t.indexOf(":");
    const prefix = colon > 0 ? t.slice(0, colon).trim().toLowerCase() : null;
    const target = (colon > 0 ? t.slice(colon + 1) : t).trim();
    if (target === "") continue;
    const n = normHeader(t);
    if (prefix === null) {
      if (n === "כולם" || n === "everyone" || n === "all") {
        out.push({ kind: "everyone", target: t });
        continue;
      }
      if (n === "צוות" || n === "staff" || n === "staff only") {
        out.push({ kind: "staff_only", target: t });
        continue;
      }
      out.push({ kind: "auto", target: t });
      continue;
    }
    if (["קבוצה", "קבוצת אם", "group", "home group", "home_group"].includes(prefix)) {
      out.push({ kind: "home_group", target });
    } else if (["מגמה", "major"].includes(prefix)) {
      out.push({ kind: "major", target });
    } else if (["קבוצת למידה", "למידה", "learning group", "lg", "learning_group"].includes(prefix)) {
      out.push({ kind: "learning_group", target });
    } else if (["צוות מדריך", "איש צוות", "staff member", "staff", "מדריך", "staff_member"].includes(prefix)) {
      out.push({ kind: "staff_member", target });
    } else {
      out.push({ kind: "auto", target: t });
    }
  }
  return out;
}

/** Parse + normalize the whole CSV. Pure — no DB access, no guessing. */
export function parseCalendarCsv(raw: string): ParsedCalendarCsv {
  const records = parseCsvRecords(raw);
  if (records.length === 0 || records[0].every((c) => c.trim() === "")) {
    return { rows: [], foundHeaders: [], fatal: "הקובץ ריק" };
  }
  const headerRow = records[0];
  const colMap = new Map<number, string>();
  const found: string[] = [];
  headerRow.forEach((cell, idx) => {
    const key = matchHeader(cell);
    if (key) {
      colMap.set(idx, key);
      found.push(key);
    }
  });
  for (const required of ["title", "startDate"]) {
    if (!found.includes(required)) {
      return {
        rows: [],
        foundHeaders: found,
        fatal: "חסרה עמודת חובה: " + (required === "title" ? "כותרת" : "תאריך התחלה"),
      };
    }
  }
  const get = (values: string[], key: string): string => {
    for (const [idx, k] of colMap) {
      if (k === key) return (values[idx] ?? "").trim();
    }
    return "";
  };

  const rows: CalendarCsvRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const values = records[r];
    if (values.every((c) => c.trim() === "")) continue; // skip blank lines
    const line = r + 1;
    const errors: string[] = [];

    const title = get(values, "title");
    if (title === "") errors.push("חסרה כותרת");
    if (title.length > 200) errors.push("הכותרת ארוכה מדי (עד 200 תווים)");

    const startDate = get(values, "startDate");
    if (startDate !== "" && !DATE_RE.test(startDate)) {
      errors.push(`תאריך התחלה לא תקין: "${startDate}" (YYYY-MM-DD)`);
    }
    const endDateRaw = get(values, "endDate");
    const endDate = endDateRaw === "" ? startDate : endDateRaw;
    if (endDate !== "" && !DATE_RE.test(endDate)) {
      errors.push(`תאריך סיום לא תקין: "${endDate}" (YYYY-MM-DD)`);
    }
    const isAllDay = parseAllDay(get(values, "isAllDay"));
    if (isAllDay === null) {
      errors.push('ערך "כל היום" לא מזוהה (כן/לא)');
    }
    const startTime = get(values, "startTime").slice(0, 5);
    const endTime = get(values, "endTime").slice(0, 5);
    if (!isAllDay) {
      if (startTime === "" || !TIME_RE.test(startTime)) {
        errors.push(`שעת התחלה נדרשת ולא תקינה: "${startTime}" (HH:MM)`);
      }
      if (endTime === "" || !TIME_RE.test(endTime)) {
        errors.push(`שעת סיום נדרשת ולא תקינה: "${endTime}" (HH:MM)`);
      } else if (
        TIME_RE.test(startTime) &&
        TIME_RE.test(endTime) &&
        startDate === endDate &&
        endTime <= startTime
      ) {
        errors.push("שעת הסיום חייבת להיות אחרי שעת ההתחלה");
      }
    }
    const recurrence = parseRecurrence(get(values, "recurrence"));
    if (recurrence === null) {
      errors.push('סוג חזרה לא מזוהה (חד פעמי / שבועי / חודשי)');
    }
    const recurrenceUntil = get(values, "recurrenceUntil");
    if (recurrence === "weekly" || recurrence === "monthly") {
      if (!DATE_RE.test(recurrenceUntil)) {
        errors.push("חזרה שבועית/חודשית דורשת תאריך סיום חזרה (YYYY-MM-DD)");
      }
    }

    const audiences = parseAudienceCell(get(values, "audiences"));
    if (audiences.length === 0) errors.push("חסר קהל יעד (למשל: כולם)");

    rows.push({
      line,
      title,
      description: get(values, "description"),
      startDate,
      startTime,
      endDate,
      endTime,
      isAllDay: isAllDay === null ? false : isAllDay,
      recurrence: recurrence === null ? "none" : recurrence,
      recurrenceUntil,
      audiences,
      errors,
    });
  }
  return { rows, foundHeaders: found };
}

/** Sample template (UTF-8, Hebrew headers) for the download button. */
export const CALENDAR_CSV_SAMPLE = [
  "כותרת,תאריך התחלה,שעת התחלה,תאריך סיום,שעת סיום,כל היום,חזרה,חזרה עד,קהל יעד,תיאור",
  'יום ספורט,2026-10-05,09:00,2026-10-05,13:00,לא,חד פעמי,,כולם,תחרויות בין הקבוצות',
  'סיור מגמה,2026-10-12,09:00,2026-10-12,11:00,לא,חד פעמי,,מגמה:מגמת תקשורת,',
  'מפגש קבוצה,2026-10-06,16:00,2026-10-06,17:30,לא,שבועי,2026-12-31,קבוצה:קבוצת זית,',
  'ישיבת צוות,2026-10-07,10:00,2026-10-07,11:30,לא,שבועי,2027-06-30,צוות,',
  'יום צילומים,2026-11-01,,,יום שלם,,,,,',
  'טקס,2026-12-01,08:30,2026-12-01,09:30,לא,חודשי,2027-05-01,כולם,כל ראש חודש',
].join("\r\n");
