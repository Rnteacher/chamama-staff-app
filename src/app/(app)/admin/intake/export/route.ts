import { NextResponse } from "next/server";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { buildCsv, csvWithBom } from "@/lib/csv-export";
import { assertNotViewAs } from "@/lib/view-as";

export const dynamic = "force-dynamic";

const HEADERS = ["שם החניך", "קבוצה", "מגמה", "הצהרת כוונות ראשונית", "מאסטר משובץ"];

/**
 * CSV export for the project coordinator.
 * GET /admin/intake/export?groupId=...&majorName=...&scope=filtered|all
 *
 * Requires project_coordinator or super_admin. View-As blocks export.
 * Exports the intake submissions + canonical project/master data.
 */
export async function GET(request: Request) {
  const me = await requireMe();
  if (
    !hasRole(me, "project_coordinator") &&
    !hasRole(me, "super_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }
  if (!(await assertNotViewAs())) {
    return NextResponse.json({ error: "לא זמין במצב צפייה" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId") || "";
  const majorFilter = searchParams.get("major") || ""; // ''=all, 'none'=לא במגמה, or major id
  const scope = searchParams.get("scope") || "filtered";

  const supabase = await createClient();

  // fetch intake submissions with joins
  let query = supabase
    .from("intake_submissions")
    .select(
      "id, intent_text, major_id, students(first_name, last_name, group_id, greenhouse_groups(name)), majors(name), " +
      "assigned:profiles!intake_submissions_assigned_master_staff_id_fkey(full_name)"
    )
    .order("updated_at", { ascending: false });
  if (scope === "filtered" && groupId) {
    query = query.eq("students.group_id", groupId);
  }
  const { data: submissions, error } = await query;
  if (error || !submissions) {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  // canonical project + primary master data
  const [projectsRes, mastersRes] = await Promise.all([
    supabase.from("student_projects").select("student_id, intent_text, major_id, majors(name)"),
    supabase.from("master_assignments").select("student_id, staff_id, is_primary, profiles(full_name)").eq("is_primary", true),
  ]);
  const projectByStudent = new Map(
    (projectsRes.data ?? []).map((p) => [p.student_id, p])
  );
  const primaryMasterByStudent = new Map(
    (mastersRes.data ?? []).map((m) => [m.student_id, m])
  );

  const rows: string[][] = [];
  for (const s of submissions) {
    const row = s as unknown as {
      id: string;
      intent_text: string;
      major_id: string | null;
      students: {
        first_name: string;
        last_name: string;
        group_id: string | null;
        greenhouse_groups: { name: string } | null;
      } | null;
      majors: { name: string } | null;
      assigned: { full_name: string | null } | null;
    };

    // major filter
    if (majorFilter) {
      const projectMajor = projectByStudent.get(row.students?.first_name + " " + row.students?.last_name)
        ? (projectByStudent.get(row.students?.first_name + " " + row.students?.last_name) as unknown as { major_id: string | null })?.major_id
        : undefined;
      if (majorFilter === "none") {
        if (row.major_id !== null || projectMajor !== null) continue;
      } else if (row.major_id !== majorFilter) {
        continue;
      }
    }

    // canonical master: primary from master_assignments, fallback to intake assigned
    const primary = primaryMasterByStudent.get(
      (row.students?.first_name ?? "") + " " + (row.students?.last_name ?? "")
    );
    const masterName =
      (primary as unknown as { profiles: { full_name: string } } | undefined)?.profiles?.full_name ??
      row.assigned?.full_name ??
      "";

    // canonical major: from project if exists, else from submission
    const proj = projectByStudent.get(
      (row.students?.first_name ?? "") + " " + (row.students?.last_name ?? "")
    );
    const majorName = proj
      ? ((proj as unknown as { majors: { name: string } | null })?.majors?.name ?? "לא במגמה")
      : row.majors?.name ?? "לא במגמה";

    rows.push([
      `${row.students?.first_name ?? ""} ${row.students?.last_name ?? ""}`.trim(),
      row.students?.greenhouse_groups?.name ?? "",
      majorName,
      row.intent_text,
      masterName,
    ]);
  }

  const csv = buildCsv(HEADERS, rows);
  const body = csvWithBom(csv);

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="intake-assignments-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
