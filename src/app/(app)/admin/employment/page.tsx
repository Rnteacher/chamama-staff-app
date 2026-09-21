import { redirect } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getViewAsState } from "@/lib/view-as";
import EmploymentAdminTable, {
  type EmploymentRow,
} from "@/components/employment/EmploymentAdminTable";

export const metadata = { title: "ניהול תעסוקה" };

export default async function EmploymentAdminPage() {
  const me = await requireMe();
  const viewAs = await getViewAsState();
  const allowed =
    hasRole(me, "employment_coordinator") ||
    hasRole(me, "leadership") ||
    hasRole(me, "super_admin");
  if (!allowed) redirect("/?error=אין%20הרשאה%20לניהול%20תעסוקה");
  // year assignment is a leadership/super_admin decision; never in View-As
  const canSetYear =
    !viewAs.active &&
    (hasRole(me, "leadership") || hasRole(me, "super_admin"));
  const supabase = await createClient();

  const [rowsRes, groupsRes] = await Promise.all([
    supabase.rpc("employment_admin_rows"),
    supabase.from("greenhouse_groups").select("id, name").order("name"),
  ]);

  const rows: EmploymentRow[] = ((rowsRes.data ?? []) as unknown as Array<{
    student_id: string;
    student_name: string;
    group_name: string | null;
    school_year: number | null;
    placement_id: string | null;
    workplace_name: string | null;
    placement_active: boolean | null;
    slots_summary: string | null;
    total_minutes: number;
    target_minutes: number;
  }>).map((r) => ({
    studentId: r.student_id,
    studentName: r.student_name,
    groupName: r.group_name,
    schoolYear: r.school_year,
    placementId: r.placement_id,
    workplaceName: r.workplace_name,
    placementActive: r.placement_active,
    slotsSummary: r.slots_summary ?? "",
    totalMinutes: Number(r.total_minutes),
    targetMinutes: Number(r.target_minutes),
  }));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-extrabold">ניהול תעסוקה</h1>
        <p className="mt-1 text-sm text-muted">
          שיבוצי עבודה, ימי עבודה מתוכננים וצבירת שעות לקראת יעד 200 השעות
          (שכבות ב/ג/ד).
        </p>
      </header>

      <EmploymentAdminTable
        rows={rows}
        groups={(groupsRes.data ?? []) as { id: string; name: string }[]}
        canSetYear={canSetYear}
      />
    </div>
  );
}
