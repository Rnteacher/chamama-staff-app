/**
 * Client-side helpers for the public intake wizard (anon Supabase client).
 * Argument names are matched EXACTLY against the deployed SQL signatures:
 *   public_intake_students(p_token text, p_group_id uuid)
 *   public_intake_majors(text) / public_intake_masters(text)
 *   public_intake_submit(p_token, p_student_id, p_group_id, p_intent,
 *                        p_major_id, p_master_staff_id)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

export interface IntakeStudent {
  id: string;
  first_name: string;
  last_name: string;
}

export interface IntakeSubmitResult {
  status: "ok" | "invalid" | "not_open" | "closed" | "error";
  message?: string;
}

function asArray(data: unknown): IntakeStudent[] {
  return Array.isArray(data) ? (data as IntakeStudent[]) : [];
}

export async function fetchIntakeStudents(
  supabase: AnyClient,
  token: string,
  groupId: string
): Promise<IntakeStudent[]> {
  const { data } = await supabase.rpc("public_intake_students", {
    p_token: token,
    p_group_id: groupId,
  });
  return asArray(data);
}

export async function submitIntake(
  supabase: AnyClient,
  input: {
    token: string;
    studentId: string;
    groupId: string;
    intent: string;
    majorId: string | null; // null = לא במגמה
    masterStaffId: string;
  }
): Promise<IntakeSubmitResult> {
  const { data } = await supabase.rpc("public_intake_submit", {
    p_token: input.token,
    p_student_id: input.studentId,
    p_group_id: input.groupId,
    p_intent: input.intent,
    p_major_id: input.majorId,
    p_master_staff_id: input.masterStaffId,
  });
  const res = (data ?? {}) as IntakeSubmitResult;
  return { status: res.status ?? "error", message: res.message };
}
