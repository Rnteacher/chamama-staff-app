/**
 * SHARED WEEKLY-SLOT / SCHEDULING PRIMITIVE (phase 1 of daily operations).
 *
 * THE single TypeScript source of truth for weekly-slot overlap logic,
 * mirrored 1:1 by the database function public.weekly_slots_overlap()
 * (migration 20260921000004). Registration submission ALWAYS recomputes
 * conflicts server-side from canonical DB schedules — this helper also powers
 * the client-side conflict UI and is the foundation future phases
 * (calendar/events, employment schedules, attendance) must extend instead of
 * re-deriving their own logic.
 *
 * Conventions (documented convention, matching the DB):
 *   * weekday: 0=Sunday .. 6=Saturday (JS Date.getDay()); the project's
 *     existing convention from the weekly-meetings model (Asia/Jerusalem).
 *   * times: local Israel wall-clock, "HH:MM" 24h strings.
 *   * touching boundaries are NOT a conflict: 10:00–11:00 + 11:00–12:00 fit.
 */

export interface WeeklySlot {
  weekday: number; // 0=Sunday..6=Saturday
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
}

export const WEEKDAY_NAMES_HE = [
  "ראשון",
  "שני",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "שבת",
] as const;

/** Re-exported short labels ("יום ב׳") from the meetings helper convention. */
export { WEEKDAY_SHORT_LABELS } from "@/lib/meetings";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTime(t: string): boolean {
  return TIME_RE.test(t);
}

/**
 * Postgres `time` columns render as "HH:MM:SS" — normalize to the canonical
 * "HH:MM" wall-clock form used across the scheduling helpers so string
 * comparisons in slotsOverlap are always consistent.
 */
export function normalizeTime(t: string): string {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(t) ? t.slice(0, 5) : t;
}

export function isValidWeekday(w: number): boolean {
  return Number.isInteger(w) && w >= 0 && w <= 6;
}

/** True when end > start (equal is invalid). */
export function isValidSlotRange(slot: WeeklySlot): boolean {
  const s = normalizeTime(slot.startTime);
  const e = normalizeTime(slot.endTime);
  if (!isValidTime(s) || !isValidTime(e)) return false;
  return s < e; // "HH:MM" compares lexicographically
}

/**
 * THE overlap primitive.
 * Two weekly slots conflict when:
 *   - same weekday
 *   - a.start < b.end
 *   - b.start < a.end
 * Touching boundaries (11:00 end + 11:00 start) are NOT a conflict.
 */
export function slotsOverlap(a: WeeklySlot, b: WeeklySlot): boolean {
  return (
    a.weekday === b.weekday &&
    normalizeTime(a.startTime) < normalizeTime(b.endTime) &&
    normalizeTime(b.startTime) < normalizeTime(a.endTime)
  );
}

/** Any slot of A overlaps any slot of B (ALL combinations compared)? */
export function slotSetsOverlap(a: WeeklySlot[], b: WeeklySlot[]): boolean {
  for (const sa of a) {
    for (const sb of b) {
      if (slotsOverlap(sa, sb)) return true;
    }
  }
  return false;
}

/** "10:00–11:30" (en-dash, kept LTR-friendly). */
export function formatSlotRangeHe(slot: WeeklySlot): string {
  return `${normalizeTime(slot.startTime)}–${normalizeTime(slot.endTime)}`;
}

/** "יום שני 10:00–11:30". */
export function formatWeeklySlotHe(slot: WeeklySlot): string {
  const name = WEEKDAY_NAMES_HE[slot.weekday] ?? "?";
  return `יום ${name} ${formatSlotRangeHe(slot)}`;
}

/** "יום שני 10:00–11:30 · יום ה׳ 12:00–13:00" (empty → ""). */
export function formatWeeklySlotsHe(slots: WeeklySlot[]): string {
  return slots
    .slice()
    .sort((x, y) => x.weekday - y.weekday || x.startTime.localeCompare(y.startTime))
    .map(formatWeeklySlotHe)
    .join(" · ");
}

/**
 * Human-readable Hebrew conflict explanation, e.g.
 *   "חופף עם צילום ביום שני 10:00–11:30"
 * where `otherGroupName` is the OTHER (already selected) group.
 */
export function describeConflictHe(
  otherGroupName: string,
  overlappingSlot: WeeklySlot
): string {
  return `חופף עם ${otherGroupName} ב${formatWeeklySlotHe(overlappingSlot)}`;
}

/**
 * The first overlapping slot between the candidate group and any selected
 * group (for the conflict UI). Returns the slot + the other group's name.
 */
export function firstConflict(
  candidateSlots: WeeklySlot[],
  selected: { name: string; slots: WeeklySlot[] }[]
): { name: string; slot: WeeklySlot } | null {
  for (const other of selected) {
    for (const cs of candidateSlots) {
      for (const os of other.slots) {
        if (slotsOverlap(cs, os)) {
          return { name: other.name, slot: cs };
        }
      }
    }
  }
  return null;
}

// ============================================================================
// PHASE 2 — annual calendar + unified daily schedule helpers
// ============================================================================

export type RecurrenceKind = "none" | "weekly" | "monthly";

export interface CalendarEventInput {
  title: string;
  startDate: string; // "YYYY-MM-DD" Jerusalem wall date
  startTime: string; // "HH:MM" ("" for all-day)
  endDate: string;
  endTime: string;
  isAllDay: boolean;
  recurrence: RecurrenceKind;
  recurrenceUntil: string; // "YYYY-MM-DD" | ""
}

/** "YYYY-MM-DD" → Date.UTC-safe parts (no timezone drift). */
export function parseISODate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** JS weekday (0=Sunday) of a "YYYY-MM-DD" wall date (UTC-safe). */
export function weekdayOf(iso: string): number {
  const { y, m, d } = parseISODate(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The next `count` wall dates with the given weekday (0=Sunday), starting
 * from the given Jerusalem date (inclusive). Used to build the concrete
 * conflict-check horizon for a recurring weekly meeting.
 */
export function upcomingWeekdayDates(
  fromDate: string,
  weekday: number,
  count: number
): string[] {
  const { y, m, d } = parseISODate(fromDate);
  const start = new Date(Date.UTC(y, m - 1, d));
  const fromWeekday = start.getUTCDay();
  const delta = (weekday - fromWeekday + 7) % 7;
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    const next = new Date(start.getTime() + (delta + i * 7) * 86_400_000);
    dates.push(
      isoDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
    );
  }
  return dates;
}

/** Human-readable Hebrew recurrence summary for the editor. */
export function describeRecurrenceHe(
  event: Pick<CalendarEventInput, "recurrence" | "recurrenceUntil" | "startDate">
): string {
  if (event.recurrence === "none") return "חד פעמי";
  const until = event.recurrenceUntil
    ? event.recurrenceUntil.split("-").reverse().join("/")
    : "";
  if (event.recurrence === "weekly") {
    const wd = weekdayOf(event.startDate);
    return `כל שבוע ביום ${WEEKDAY_NAMES_HE[wd]}${until ? `, עד ${until}` : ""}`;
  }
  const dom = parseISODate(event.startDate).d;
  return `כל חודש בתאריך ${dom}${until ? `, עד ${until}` : ""}`;
}

/** Normalized unified schedule item shape (mirrors the SQL RPCs). */
export interface ScheduleItem {
  sourceType: "calendar_event" | "meeting" | "learning_group";
  sourceId: string;
  title: string;
  startAt: string; // ISO
  endAt: string; // ISO
  isAllDay: boolean;
  context: string | null;
  linkPath: string | null;
}

/** All-day items first, then chronological by start time. */
export function sortScheduleItems(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => {
    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
    return a.startAt.localeCompare(b.startAt);
  });
}

/** Is "now" inside [start, end)? (for the current-item highlight) */
export function isNow(item: Pick<ScheduleItem, "startAt" | "endAt">, now = new Date()): boolean {
  const t = now.getTime();
  return new Date(item.startAt).getTime() <= t && t < new Date(item.endAt).getTime();
}
