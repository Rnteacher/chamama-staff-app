/**
 * School-week + meeting-time helpers.
 *
 * The school week is Sunday 00:00 → Saturday 23:59 in Asia/Jerusalem.
 * All helpers are pure and testable (see tests/unit/meetings.test.ts).
 */

export const SCHOOL_TIMEZONE = "Asia/Jerusalem";

/** Weekday labels, indexed 0=Sunday..6=Saturday (matches JS getDay()). */
export const WEEKDAY_LABELS = [
  "ראשון",
  "שני",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "שבת",
] as const;

export const WEEKDAY_SHORT_LABELS = [
  "יום א׳",
  "יום ב׳",
  "יום ג׳",
  "יום ד׳",
  "יום ה׳",
  "יום ו׳",
  "יום ש׳",
] as const;

export interface JerusalemParts {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sunday (like getDay())
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asUtc - date.getTime();
}

/** Wall-clock parts of an instant in the school timezone. */
export function jerusalemParts(date: Date): JerusalemParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHOOL_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") % 24;
  const minute = get("minute");
  // weekday from the Jerusalem calendar date
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

/**
 * Convert a Jerusalem wall-clock date/time to an absolute UTC instant.
 * DST-safe (two-pass offset resolution).
 */
export function jerusalemWallTimeToUtc(
  year: number,
  month: number, // 1-based
  day: number,
  hour: number,
  minute: number
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall;
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMs(new Date(utc), SCHOOL_TIMEZONE);
    utc = wall - offset;
  }
  return new Date(utc);
}

/** The Sunday (Asia/Jerusalem) opening the school week of the given instant. */
export function schoolWeekStart(date: Date = new Date()): string {
  const p = jerusalemParts(date);
  const utcMidnight = Date.UTC(p.year, p.month - 1, p.day);
  const sunday = utcMidnight - p.weekday * 86_400_000;
  const d = new Date(sunday);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * True when the given instant belongs to the same Asia/Jerusalem
 * Sunday–Saturday school week as the reference week start (YYYY-MM-DD).
 */
export function isInSchoolWeek(instant: Date, weekStart: string): boolean {
  return schoolWeekStart(instant) === weekStart;
}

/** "HH:MM" label for a Date in Jerusalem time. */
export function jerusalemTimeLabel(date: Date): string {
  const p = jerusalemParts(date);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * The absolute instant of a weekly slot within the school week starting at
 * `weekStart` (YYYY-MM-DD Sunday, Asia/Jerusalem). Mirrors the SQL:
 * ((week_start + weekday)::date + meeting_time) AT TIME ZONE 'Asia/Jerusalem'.
 */
export function slotInstant(
  weekStart: string,
  weekday: number, // 0=Sunday
  time: string // "HH:MM"
): Date {
  const [y, m, d] = weekStart.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return jerusalemWallTimeToUtc(y, m, d + weekday, hh, mm);
}

/** Validation helper: "HH:MM" 24h format. */
export function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** Deep link for a meeting-reminder push: opens the report action directly. */
export function meetingDeepLink(studentId: string, occurrenceId: string): string {
  return `/students/${studentId}?meeting=${occurrenceId}&report=1`;
}
