import { redirect } from "next/navigation";
import { requireMe, hasRole } from "@/lib/auth";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import IntakeManager, {
  type IntakeSubmissionRow,
  type IntakeWindowRow,
} from "@/components/admin/IntakeManager";

export const metadata = { title: "ניהול · קבלת פרויקטים" };

export default async function AdminIntakePage() {
  const me = await requireMe();
  // project coordinator OR super_admin (server-side; never email-based)
  if (!hasRole(me, "project_coordinator") && !hasRole(me, "super_admin")) {
    redirect("/?error=אין%20הרשאת%20רכז/ת%20פרויקטים");
  }

  const supabase = await createClient();
  // NOTE: intake_window_tokens is intentionally NOT granted to authenticated
  // (it holds encrypted token material), so it must never be embedded in a
  // user-client query. Its presence flag is read below via the service-role
  // client AFTER the authorization gate above.
  const [windowsRes, submissionsRes, staffRes, groupsRes, majorsRes] =
    await Promise.all([
      supabase
        .from("intake_windows")
        .select(
          "id, title, opens_at, closes_at, is_revoked, created_at, profiles(full_name), encrypted_token"
        )
        .is("deleted_at", null) // deleted intake windows disappear from the management list
        .order("created_at", { ascending: false }),
      supabase
        .from("intake_submissions")
        .select(
          "id, intake_id, intent_text, major_id, requested_master_staff_id, assigned_master_staff_id, updated_at, students(first_name, last_name, group_id, greenhouse_groups(name)), majors(name), requested:profiles!intake_submissions_requested_master_staff_id_fkey(full_name), assigned:profiles!intake_submissions_assigned_master_staff_id_fkey(full_name)"
        )
        .order("updated_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .order("full_name"),
      supabase.from("greenhouse_groups").select("id, name").order("name"),
      supabase.from("majors").select("id, name").order("name"),
    ]);

  // never swallow a query error — a broken select/filter must surface loudly
  // (a silent empty list looks exactly like "all intake windows disappeared")
  if (windowsRes.error) {
    console.error("[admin/intake] intake_windows query failed:", windowsRes.error);
    throw new Error(`טעינת טפסי הקבלה נכשלה: ${windowsRes.error.message}`);
  }
  if (submissionsRes.error) {
    console.error("[admin/intake] intake_submissions query failed:", submissionsRes.error);
  }

  // authorized service-role read: which of THESE windows has recoverable
  // additional-token material (scoped to the ids returned above)
  const windowIds = (windowsRes.data ?? []).map((w) => w.id as string);
  const recoverableIds = new Set<string>();
  if (windowIds.length > 0) {
    const { data: tokenRows, error: tokenErr } = await createAdminClient()
      .from("intake_window_tokens")
      .select("intake_window_id, encrypted_token, revoked_at")
      .in("intake_window_id", windowIds);
    if (tokenErr) {
      console.error("[admin/intake] intake_window_tokens query failed:", tokenErr);
      throw new Error(`טעינת טפסי הקבלה נכשלה: ${tokenErr.message}`);
    }
    for (const t of tokenRows ?? []) {
      if (t.encrypted_token && t.revoked_at === null) {
        recoverableIds.add(t.intake_window_id as string);
      }
    }
  }

  const windows: IntakeWindowRow[] = (windowsRes.data ?? []).map((w) => {
    const row = w as unknown as {
      id: string;
      title: string;
      opens_at: string;
      closes_at: string;
      is_revoked: boolean;
      encrypted_token: string | null;
      profiles: { full_name: string | null } | null;
    };
    // recoverable = the window's own encrypted token OR an active additional
    // token with encrypted material. Only the BOOLEAN reaches the browser —
    // never encrypted_token / encryption_iv / encryption_tag / plaintext.
    const hasRecoverableLink =
      Boolean(row.encrypted_token) || recoverableIds.has(row.id);
    return {
      id: row.id,
      title: row.title,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      isRevoked: row.is_revoked,
      hasRecoverableLink,
      createdByName: row.profiles?.full_name ?? null,
    };
  });

  const submissions: IntakeSubmissionRow[] = (submissionsRes.data ?? []).map((s) => {
    const row = s as unknown as {
      id: string;
      intake_id: string;
      intent_text: string;
      major_id: string | null;
      requested_master_staff_id: string;
      assigned_master_staff_id: string | null;
      updated_at: string;
      students: {
        first_name: string;
        last_name: string;
        group_id: string | null;
        greenhouse_groups: { name: string } | null;
      } | null;
      majors: { name: string } | null;
      requested: { full_name: string | null } | null;
      assigned: { full_name: string | null } | null;
    };
    return {
      id: row.id,
      intakeId: row.intake_id,
      intentText: row.intent_text,
      majorName: row.majors?.name ?? null,
      requestedMasterName: row.requested?.full_name ?? "—",
      requestedMasterId: row.requested_master_staff_id,
      assignedMasterId: row.assigned_master_staff_id,
      studentName: row.students
        ? `${row.students.first_name} ${row.students.last_name}`
        : "—",
      groupId: row.students?.group_id ?? null,
      groupName: row.students?.greenhouse_groups?.name ?? null,
      updatedAt: row.updated_at,
    };
  });

  const staff = (staffRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.full_name ?? "—",
  }));

  return (
    <IntakeManager
      windows={windows}
      submissions={submissions}
      staff={staff}
      groups={groupsRes.data ?? []}
      majors={majorsRes.data ?? []}
    />
  );
}
