import { redirect } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";
import { getViewAsState } from "@/lib/view-as";
import { createClient } from "@/lib/supabase/server";
import { fetchCalendarRange } from "@/lib/calendar";
import { jerusalemParts } from "@/lib/meetings";
import { isoDate } from "@/lib/schedule";
import AnnualCalendar from "@/components/calendar/AnnualCalendar";
import CalendarCsvImport from "@/components/calendar/CalendarCsvImport";
import type { MultiSelectOption } from "@/components/learning-groups/MultiSelectCheckbox";

export const metadata = { title: "לוח שנה" };

export interface RawCalendarEvent {
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
}

/** The school year (September–August) containing the given date. */
function schoolYearRange(today: { y: number; m: number }): {
  from: string;
  to: string;
  label: string;
  months: { y: number; m: number }[];
} {
  const startYear = today.m >= 8 ? today.y : today.y - 1;
  const months: { y: number; m: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const month = ((8 + i) % 12) + 1; // September=9 ... August=8
    const y = startYear + (8 + i >= 12 ? 1 : 0);
    months.push({ y, m: month });
  }
  return {
    from: `${startYear}-09-01`,
    to: `${startYear + 1}-08-31`,
    label: `שנת הלימודים ${startYear}-${startYear + 1}`,
    months,
  };
}

export default async function CalendarPage({
  searchParams,
}: PageProps<"/calendar">) {
  const me = await requireMe();
  // SERVER-SIDE route security: full calendar management (views, add/edit/
  // delete/cancel, CSV import) is leadership/super_admin ONLY. Direct URL
  // access by ordinary staff is denied — not merely hidden from navigation.
  // (Events still reach ordinary staff through staff_day_schedule / היום שלי.)
  // View-As: the real viewer must be calendar-admin; mutations stay blocked
  // (canManage=false in View-As below).
  if (!hasRole(me, "leadership") && !hasRole(me, "super_admin")) {
    redirect("/access-denied");
  }
  const viewAs = await getViewAsState();
  const supabase = await createClient();

  const params = await searchParams;
  const initialDate =
    typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : null;
  const initialEventId =
    typeof params.event === "string" && /^[0-9a-f-]{36}$/i.test(params.event)
      ? params.event
      : null;

  const p = jerusalemParts(new Date());
  const todayISO = isoDate(p.year, p.month, p.day);
  const range = schoolYearRange({ y: p.year, m: p.month });

  const [occurrences, rawEvents, rawAudiences] = await Promise.all([
    fetchCalendarRange(supabase, range.from, range.to),
    supabase
      .from("calendar_events")
      .select("id, title, description, start_date, start_time, end_date, end_time, is_all_day, recurrence, recurrence_until, status")
      .is("deleted_at", null),
    supabase
      .from("calendar_event_audiences")
      .select("event_id, audience_type, greenhouse_group_id, major_id, learning_group_id, staff_id"),
  ]);

  // canManage: leadership OR super_admin, never in View-As (read-only there)
  const canManage =
    !viewAs.active &&
    me.staffId !== null &&
    (hasRole(me, "leadership") || hasRole(me, "super_admin"));

  let editorData: {
    groups: { id: string; name: string }[];
    majors: { id: string; name: string }[];
    learningGroups: { id: string; name: string; isActive: boolean }[];
    staff: MultiSelectOption[];
  } | null = null;

  if (canManage) {
    const [groupsRes, majorsRes, lgRes, staffRes] = await Promise.all([
      supabase.from("greenhouse_groups").select("id, name").order("name"),
      supabase.from("majors").select("id, name").order("name"),
      supabase
        .from("learning_groups")
        .select("id, name, is_active")
        .order("name"),
      supabase
        .from("profiles")
        .select("id, email, full_name, auth_user_id")
        .eq("is_active", true)
        .order("full_name"),
    ]);
    editorData = {
      groups: groupsRes.data ?? [],
      majors: majorsRes.data ?? [],
      learningGroups: (lgRes.data ?? []).map((g) => {
        const row = g as unknown as { id: string; name: string; is_active: boolean };
        return { id: row.id, name: row.name, isActive: row.is_active };
      }),
      staff: (staffRes.data ?? []).map((s) => {
        const row = s as unknown as {
          id: string;
          email: string;
          full_name: string | null;
          auth_user_id: string | null;
        };
        return {
          id: row.id,
          label: row.full_name ?? row.email,
          hint: row.auth_user_id === null ? "טרם התחבר/ה" : undefined,
        };
      }),
    };
  }

  return (
    <div className="flex flex-col gap-5">
      <AnnualCalendar
        occurrences={occurrences}
        events={(rawEvents.data ?? []) as unknown as RawCalendarEvent[]}
        audiences={
          (rawAudiences.data ?? []) as unknown as {
            event_id: string;
            audience_type: "everyone" | "staff_only" | "home_group" | "major" | "learning_group" | "staff_member";
            greenhouse_group_id: string | null;
            major_id: string | null;
            learning_group_id: string | null;
            staff_id: string | null;
          }[]
        }
        months={range.months}
        yearLabel={range.label}
        todayISO={todayISO}
        canManage={canManage}
        editorData={editorData}
        initialDate={initialDate}
        initialEventId={initialEventId}
      />
      {/* CSV import — same leadership/super_admin guard as the whole screen */}
      {canManage && <CalendarCsvImport />}
    </div>
  );
}
