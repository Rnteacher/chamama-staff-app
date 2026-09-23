import Link from "next/link";
import {
  computeEmploymentProgress,
  employmentApplies,
  formatHoursLabel,
  formatWorkSlotsHe,
  type EmploymentOverviewData,
} from "@/lib/employment";
import EmploymentOverrideControl from "@/components/employment/EmploymentOverrideControl";

/**
 * Employment summary on the student page: workplace, planned work days,
 * accumulated hours toward the 200h target and recent work logs.
 * Contact details are NOT rendered here (kept off broad surfaces).
 * Authorized employment managers also get the tri-state eligibility
 * override here — eligibility is operational logic, not a label.
 *
 * When employment does not apply to the student (effectively ineligible and
 * no existing records) the section is not rendered at all — for every
 * viewer. Managers enable it from the student header ("הוספה לתעסוקה").
 */
export default function StudentEmploymentCard({
  data,
  studentId,
  canManageOverride = false,
}: {
  data: EmploymentOverviewData;
  studentId: string;
  canManageOverride?: boolean;
}) {
  if (!employmentApplies(data)) return null;
  const p = computeEmploymentProgress(data.total_minutes);

  return (
    <section aria-labelledby="employment-heading" className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="employment-heading" className="font-extrabold">תעסוקה</h2>
        {data.can_manage && (
          <Link
            href={`/admin/employment/${studentId}`}
            className="rounded-full border border-line px-3 py-1 text-xs font-bold hover:bg-brand-soft/40"
          >
            ניהול תעסוקה ›
          </Link>
        )}
      </div>

      {canManageOverride && (
        <EmploymentOverrideControl
          studentId={studentId}
          override={data.override ?? "automatic"}
        />
      )}

      {!data.eligible && (
        // existing records stay reachable after eligibility was withdrawn
        <p className="mt-2 text-sm text-muted">לא משתתף/ת כרגע בתוכנית התעסוקה.</p>
      )}

      {!data.placement ? (
        <p className="mt-2 text-sm text-muted">אין שיבוץ לעבודה.</p>
      ) : (
        <>
          <dl className="mt-2 flex flex-col gap-1 text-sm">
            <div className="flex gap-1">
              <dt className="font-bold">מקום עבודה:</dt>
              <dd className="text-muted">{data.placement.workplace_name}</dd>
              {!data.placement.is_active && (
                <dd className="rounded-full border border-warn px-2 text-xs font-bold text-warn">
                  שיבוץ שהסתיים
                </dd>
              )}
            </div>
            {data.placement.is_active && data.weekly_slots.length > 0 && (
              <div className="flex gap-1">
                <dt className="font-bold">ימי עבודה:</dt>
                <dd className="text-muted">{formatWorkSlotsHe(data.weekly_slots)}</dd>
              </div>
            )}
          </dl>

          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-extrabold" dir="ltr">{p.label}</span>
              {p.remainingMinutes > 0 && (
                <span className="text-xs text-muted">
                  נותרו {formatHoursLabel(p.remainingMinutes)}
                </span>
              )}
              {p.bucket === "above" && (
                <span className="text-xs font-bold text-brand-dark">הושלם מעבר ליעד!</span>
              )}
            </div>
            <span className="mt-1 block h-2 overflow-hidden rounded-full bg-line">
              <span
                className={`block h-full rounded-full ${p.bucket === "above" ? "bg-ink" : "bg-brand"}`}
                style={{ width: `${Math.min(100, p.percent)}%` }}
              />
            </span>
          </div>

          {data.recent_logs.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-bold text-muted">שעות אחרונות</h3>
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {data.recent_logs.slice(0, 5).map((l) => (
                  <li key={l.id} className="flex items-baseline justify-between gap-2">
                    <span dir="ltr" className="text-muted">
                      {l.work_date}
                      {l.start_time ? ` · ${l.start_time.slice(0, 5)}–${l.end_time?.slice(0, 5)}` : ""}
                    </span>
                    <span className="font-bold">{formatHoursLabel(l.duration_minutes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
