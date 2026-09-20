import { NextResponse } from "next/server";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { buildCsv, csvWithBom } from "@/lib/csv-export";
import { assertNotViewAs } from "@/lib/view-as";

export const dynamic = "force-dynamic";

const HEADERS = ["שם החניך", "קבוצה", "מגמה", "הצהרת כוונות ראשונית", "מאסטר משובץ"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const me = await requireMe();
  if (!hasRole(me, "project_coordinator") && !hasRole(me, "super_admin")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }
  if (!(await assertNotViewAs())) {
    return NextResponse.json({ error: "לא זמין במצב צפייה" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const intakeId = searchParams.get("intakeId") ?? "";
  // a specific intake window is REQUIRED — never fall back to "export all"
  if (!UUID_RE.test(intakeId)) {
    return NextResponse.json(
      { error: "intakeId is required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // the window must exist and be manageable (not soft-deleted)
  const { data: windowRow, error: windowErr } = await supabase
    .from("intake_windows")
    .select("id, title")
    .eq("id", intakeId)
    .is("deleted_at", null)
    .maybeSingle();
  if (windowErr) {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
  if (!windowRow) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // submissions belonging ONLY to the selected intake
  const { data: submissions, error } = await supabase
    .from("intake_submissions")
    .select(
      "id, intent_text, updated_at, students(id, first_name, last_name, greenhouse_groups(name)), majors(name), " +
      "assigned:profiles!intake_submissions_assigned_master_staff_id_fkey(full_name)"
    )
    .eq("intake_id", intakeId)
    .order("updated_at", { ascending: false });
  if (error || !submissions) {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  // canonical assigned primary master (assignment decided by the coordinator)
  const { data: mastersRes } = await supabase
    .from("master_assignments")
    .select("student_id, is_primary, profiles(full_name)")
    .eq("is_primary", true);
  const primaryByStudent = new Map(
    (mastersRes ?? []).map((m) => [m.student_id, m])
  );

  const rows: string[][] = [];
  for (const s of submissions) {
    const row = s as unknown as {
      id: string;
      intent_text: string;
      updated_at: string;
      students: {
        id: string;
        first_name: string;
        last_name: string;
        greenhouse_groups: { name: string } | null;
      } | null;
      majors: { name: string } | null;
      assigned: { full_name: string | null } | null;
    };
    const studentName = row.students
      ? `${row.students.first_name} ${row.students.last_name}`.trim()
      : "";
    const groupName = row.students?.greenhouse_groups?.name ?? "";
    // intended major: the requested major from the submission itself
    const majorName = row.majors?.name ?? "לא במגמה";

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
      // header values must be ByteString — keep the filename ASCII
      "Content-Disposition": `attachment; filename="intake-export-${date}.csv"`,
    },
  });
}
