"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type CalendarOccurrence,
} from "@/lib/calendar";
import EventEditorDialog, {
  type EditorEventData,
  type EditorOptions,
} from "@/components/calendar/EventEditorDialog";
import { isoDate, parseISODate, weekdayOf, WEEKDAY_SHORT_LABELS } from "@/lib/schedule";

const MONTH_LABELS_HE = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

const WEEKDAY_HEADER = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

export interface AnnualCalendarProps {
  occurrences: CalendarOccurrence[];
  events: {
    id: string;
    title: string;
    description: string | null;
    start_date: string;
    start_time: string;
    end_date: string;
    end_time: string;
    is_all_day: boolean;
    recurrence: "none" | "weekly" | "monthly";
    recurrence_until: string | null;
    status: "active" | "cancelled";
  }[];
  audiences: {
    event_id: string;
    audience_type: "everyone" | "staff_only" | "home_group" | "major" | "learning_group" | "staff_member";
    greenhouse_group_id: string | null;
    major_id: string | null;
    learning_group_id: string | null;
    staff_id: string | null;
  }[];
  months: { y: number; m: number }[];
  yearLabel: string;
  todayISO: string;
  canManage: boolean;
  editorData: EditorOptions | null;
  initialDate: string | null;
  initialEventId: string | null;
}

/** local (UTC-safe) date string of an ISO timestamp's Jerusalem wall date */
function wallDateOf(iso: string): string {
  const d = new Date(iso);
  const jerusalem = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return jerusalem; // en-CA → YYYY-MM-DD
}

function timeLabelHe(iso: string): string {
  const d = new Date(iso);
  const t = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return t;
}

/** Days grid of one month (Sunday-first), padded with nulls for RTL flow. */
function monthDays(y: number, m: number): (string | null)[] {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = first.getUTCDay(); // 0=Sunday
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(isoDate(y, m, d));
  }
  return cells;
}

export default function AnnualCalendar({
  occurrences,
  events,
  audiences,
  months,
  yearLabel,
  todayISO,
  canManage,
  editorData,
  initialDate,
  initialEventId,
}: AnnualCalendarProps) {
  const router = useRouter();

  const eventsById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const audiencesByEvent = useMemo(() => {
    const map = new Map<string, EditorEventData["audiences"]>();
    for (const a of audiences) {
      map.set(a.event_id, [
        ...(map.get(a.event_id) ?? []),
        {
          type: a.audience_type,
          greenhouseGroupId: a.greenhouse_group_id,
          majorId: a.major_id,
          learningGroupId: a.learning_group_id,
          staffId: a.staff_id,
        },
      ]);
    }
    return map;
  }, [audiences]);

  // occurrences grouped by Jerusalem wall date
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarOccurrence[]>();
    for (const o of occurrences) {
      const key = wallDateOf(o.occurrenceStart);
      map.set(key, [...(map.get(key) ?? []), o]);
    }
    return map;
  }, [occurrences]);

  const [selectedDate, setSelectedDate] = useState<string | null>(
    initialDate ?? todayISO
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<EditorEventData | null>(null);

  useEffect(() => {
    const timer = setTimeout(async () => {
      await Promise.resolve();
      if (initialEventId) {
        const raw = eventsById.get(initialEventId);
        if (raw) {
          setEditorInitial(editorDataFromEvent(raw, audiencesByEvent.get(raw.id) ?? []));
          setEditorOpen(true);
        }
      } else if (initialDate) {
        setSelectedDate(initialDate);
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dayOccurrences = selectedDate ? (byDate.get(selectedDate) ?? []) : [];

  // mobile agenda: today + next 30 days
  const agenda = useMemo(() => {
    const out: { date: string; items: CalendarOccurrence[] }[] = [];
    const { y, m, d } = parseISODate(todayISO);
    const start = Date.UTC(y, m - 1, d);
    for (let i = 0; i < 31; i++) {
      const dt = new Date(start + i * 86_400_000);
      const key = isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
      const items = byDate.get(key);
      if (items && items.length > 0) out.push({ date: key, items });
    }
    return out;
  }, [byDate, todayISO]);

  function openCreate(dateISO: string) {
    setEditorInitial({
      id: null,
      title: "",
      description: "",
      startDate: dateISO,
      startTime: "10:00",
      endDate: dateISO,
      endTime: "11:30",
      isAllDay: false,
      recurrence: "none",
      recurrenceUntil: "",
      audiences: [],
    });
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setEditorInitial(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-extrabold">לוח שנה</h1>
          <p className="text-sm text-muted">{yearLabel}</p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => openCreate(selectedDate ?? todayISO)}
            className="rounded-full bg-ink px-4 py-2 text-sm font-bold text-white"
          >
            הוספת אירוע
          </button>
        )}
      </header>

      {/* ---------------------------------------------- desktop year view -- */}
      <div className="hidden gap-3 lg:grid lg:grid-cols-4 xl:grid-cols-4" dir="rtl">
        {months.map(({ y, m }) => (
          <MonthCard
            key={`${y}-${m}`}
            y={y}
            m={m}
            byDate={byDate}
            todayISO={todayISO}
            selectedDate={selectedDate}
            onSelect={(date) => {
              setSelectedDate(date);
              router.replace(`/calendar?date=${date}`, { scroll: false });
            }}
          />
        ))}
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* day/month detail (desktop side panel; mobile deep-link panel) */}
        {selectedDate && (
          <section
            aria-label="פירוט יום"
            className="w-full shrink-0 rounded-2xl border border-line bg-surface p-4 lg:sticky lg:top-20 lg:w-96"
          >
            <h2 className="font-extrabold">{dayTitleHe(selectedDate)}</h2>
            {dayOccurrences.length === 0 ? (
              <p className="mt-2 text-sm text-muted">אין אירועים ביום זה.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {dayOccurrences.map((o, i) => (
                  <li key={`${o.eventId}-${i}`}>
                    <button
                      type="button"
                      onClick={() => {
                        const raw = eventsById.get(o.eventId);
                        setEditorInitial(
                          canManage && raw
                            ? editorDataFromEvent(raw, audiencesByEvent.get(o.eventId) ?? [])
                            : editorDataFromOccurrence(o, audiencesByEvent.get(o.eventId) ?? [])
                        );
                        setEditorOpen(true);
                      }}
                      className="flex w-full items-start justify-between gap-2 rounded-xl border border-line bg-bg px-3 py-2.5 text-right text-sm hover:bg-brand-soft/40"
                    >
                      <span className="min-w-0">
                        <span className="block font-bold">{o.title}</span>
                        {o.audienceLabels.length > 0 && (
                          <span className="block truncate text-xs text-muted">
                            {o.audienceLabels.join(" · ")}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs font-semibold text-muted" dir="ltr">
                        {o.isAllDay ? "כל היום" : `${timeLabelHe(o.occurrenceStart)}–${timeLabelHe(o.occurrenceEnd)}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {canManage && (
              <button
                type="button"
                onClick={() => openCreate(selectedDate)}
                className="mt-3 rounded-full border border-line px-3 py-1.5 text-xs font-bold hover:bg-brand-soft/40"
              >
                + אירוע ביום זה
              </button>
            )}
          </section>
        )}

        {/* ------------------------------------------------ mobile agenda -- */}
        <section aria-label="אירועים קרובים" className="min-w-0 flex-1 lg:hidden">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold">היום והתקופה הקרובה</h2>
            <a href="#today-agenda" className="text-sm font-medium text-brand-dark">
              היום ›
            </a>
          </div>
          {agenda.length === 0 ? (
            <p className="mt-2 text-sm text-muted">אין אירועים בשבועות הקרובים.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {agenda.map(({ date, items }) => (
                <li key={date} id={date === todayISO ? "today-agenda" : undefined}>
                  <p className="text-sm font-bold">{dayTitleHe(date)}</p>
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {items.map((o, i) => (
                      <li key={`${o.eventId}-${i}`}>
                        <button
                          type="button"
                          onClick={() => {
                            const raw = eventsById.get(o.eventId);
                            setEditorInitial(
                              canManage && raw
                                ? editorDataFromEvent(raw, audiencesByEvent.get(o.eventId) ?? [])
                                : editorDataFromOccurrence(o, audiencesByEvent.get(o.eventId) ?? [])
                            );
                            setEditorOpen(true);
                          }}
                          className="flex w-full items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-4 py-3 text-right text-sm hover:bg-brand-soft/40"
                        >
                          <span className="min-w-0">
                            <span className="block font-bold">{o.title}</span>
                            {o.audienceLabels.length > 0 && (
                              <span className="block truncate text-xs text-muted">
                                {o.audienceLabels.join(" · ")}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-xs font-semibold text-muted" dir="ltr">
                            {o.isAllDay ? "כל היום" : timeLabelHe(o.occurrenceStart)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {editorOpen && editorInitial && (
        <EventEditorDialog
          initial={editorInitial}
          options={editorData}
          canManage={canManage}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}

type RawEvent = {
  id: string;
  title: string;
  description: string | null;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  is_all_day: boolean;
  recurrence: "none" | "weekly" | "monthly";
  recurrence_until: string | null;
  status: "active" | "cancelled";
};

/** Editor payload from the CANONICAL event definition (edit mode). */
function editorDataFromEvent(
  raw: RawEvent,
  audiences: EditorEventData["audiences"]
): EditorEventData {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description ?? "",
    startDate: raw.start_date,
    startTime: raw.start_time.slice(0, 5),
    endDate: raw.end_date,
    endTime: raw.end_time.slice(0, 5),
    isAllDay: raw.is_all_day,
    recurrence: raw.recurrence,
    recurrenceUntil: raw.recurrence_until ?? "",
    audiences,
  };
}

/** Read-only details from an occurrence (non-managers). */
function editorDataFromOccurrence(
  o: CalendarOccurrence,
  audiences: EditorEventData["audiences"]
): EditorEventData {
  return {
    id: o.eventId,
    title: o.title,
    description: o.description ?? "",
    startDate: wallDateOf(o.occurrenceStart),
    startTime: timeLabelHe(o.occurrenceStart),
    endDate: wallDateOf(o.occurrenceEnd),
    endTime: timeLabelHe(o.occurrenceEnd),
    isAllDay: o.isAllDay,
    recurrence: o.recurrence,
    recurrenceUntil: "",
    audiences,
  };
}

function dayTitleHe(dateISO: string): string {
  const { y, m, d } = parseISODate(dateISO);
  const wd = weekdayOf(dateISO);
  const monthName = new Intl.DateTimeFormat("he-IL", { month: "long" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
  return `${WEEKDAY_SHORT_LABELS[wd]}, ${d} ב${monthName}`;
}

function MonthCard({
  y,
  m,
  byDate,
  todayISO,
  selectedDate,
  onSelect,
}: {
  y: number;
  m: number;
  byDate: Map<string, CalendarOccurrence[]>;
  todayISO: string;
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const cells = monthDays(y, m);
  return (
    <section
      aria-label={`${MONTH_LABELS_HE[m - 1]} ${y}`}
      className="rounded-2xl border border-line bg-surface p-3"
    >
      <h3 className="text-center text-sm font-extrabold">
        {MONTH_LABELS_HE[m - 1]} {y}
      </h3>
      <div className="mt-1.5 grid grid-cols-7 gap-0.5 text-center text-[10px] text-muted">
        {WEEKDAY_HEADER.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="mt-0.5 grid grid-cols-7 gap-0.5">
        {cells.map((date, idx) =>
          date === null ? (
            <span key={`pad-${idx}`} />
          ) : (
            <button
              key={date}
              type="button"
              data-date={date}
              onClick={() => onSelect(date)}
              aria-current={date === todayISO ? "date" : undefined}
              className={`relative flex min-h-[38px] flex-col items-center rounded-lg px-0.5 py-0.5 text-xs transition-colors ${
                date === selectedDate
                  ? "bg-brand-dark text-white"
                  : date === todayISO
                    ? "bg-brand-soft font-extrabold text-ink ring-2 ring-brand-dark"
                    : "hover:bg-brand-soft/40"
              }`}
            >
              <span>{Number(date.slice(-2))}</span>
              <span className="mt-0.5 flex h-1.5 items-center gap-0.5" aria-hidden="true">
                {(byDate.get(date) ?? []).slice(0, 3).map((o, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-1.5 rounded-full ${
                      date === selectedDate ? "bg-white" : o.isAllDay ? "bg-ink/60" : "bg-brand-dark"
                    }`}
                  />
                ))}
              </span>
            </button>
          )
        )}
      </div>
    </section>
  );
}
