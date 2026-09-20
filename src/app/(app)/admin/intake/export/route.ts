import { NextResponse } from "next/server";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { buildCsv, csvWithBom } from "@/lib/csv-export";
import { assertNotViewAs } from "@/lib/view-as";

export const dynamic = "force-dynamic";

const HEADERS = ["שם החניך", "קבוצה", "מגמה", "הצהרת כוונות ראשונית", "מאסטר משובץ"];

export async function GET(request: Request) {
  const me = await requireMe();
  if (!hasRole(me, "project_coordinator") && !hasRole(me, "super_admin")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }
  if (!(await assertNotViewAs())) {
    return NextResponse.json({ error: "לא זמין במצב צפייה" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const intakeId = searchParams.get("intakeId") || "";
  const groupId = searchParams.get("groupId") || "";
  const majorFilter = searchParams.get("major") || "";

  const supabase = await createClient();

  // fetch submissions for the selected intake
  let query = supabase
    .from("intake_submissions")
    .select(
      "id, intent_text, major_id, updated_at, students(id, first_name, last_name, group_id, greenhouse_groups(name)), majors(name), " +
      "assigned:profiles!intake_submissions_assigned_master_staff_id_fkey(full_name)"
    )
    .order("updated_at", { ascending: false });
  if (intakeId) query = query.eq("intake_id", intakeId);
  const { data: submissions, error } = await query;
  if (error || !submissions) {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  // fetch canonical project + primary master data
  const [projectsRes, mastersRes] = await Promise.all([
    supabase.from("student_projects").select("student_id, intent_text, major_id, majors(name)"),
    supabase.from("master_assignments").select("student_id, is_primary, profiles(full_name)").eq("is_primary", true),
  ]);
  const projectByStudent = new Map(
    (projectsRes.data ?? []).map((p) => [p.student_id, p])
  );
  const primaryByStudent = new Map(
    (mastersRes.data ?? []).map((m) => [m.student_id, m])
  );

  const rows: string[][] = [];
  for (const s of submissions) {
    const row = s as unknown as {
      id: string;
      intent_text: string;
      major_id: string | null;
      updated_at: string;
      students: {
        id: string;
        first_name: string;
        last_name: string;
        group_id: string | null;
        greenhouse_groups: { name: string } | null;
      } | null;
      majors: { name: string } | null;
      assigned: { full_name: string | null } | null;
    };
    const studentName = row.students
      ? `${row.students.first_name} ${row.students.last_name}`.trim()
      : "";
    const groupName = row.students?.greenhouse_groups?.name ?? "";
    const groupId = row.students?.group_id ?? "";

    if (groupId && (row.students?.id ?? "") !== groupId) continue;

    // canonical project major
    const proj = projectByStudent.get(row.students?.id ?? "");
    const majorName = proj
      ? ((proj as unknown as { majors: { name: string } | null })?.majors?.name ?? "לא במגמה")
      : row.majors?.name ?? "לא במגמה";

    if (majorFilter) {
      if (majorFilter === "none") {
        if (majorName !== "לא במגמה" && majorName !== "") continue;
      } else if (majorName !== majorFilter) continue;
    }

    const primary = primaryByStudent.get(row.students?.id ?? "");
    const masterName =
      (primary as unknown as { profiles: { full_name: string } } | undefined)?.profiles?.full_name ??
      row.assigned?.full_name ??
      "טרם שובץ";

    rows.push([studentName, groupName, majorName, row.intent_text, masterName]);
  }

  const csv = buildCsv(HEADERS, rows);
  const body = csvWithBom(csv);

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="chamama-project-assignments-${date}.csv"`,
    },
  });
}
