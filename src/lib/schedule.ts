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
