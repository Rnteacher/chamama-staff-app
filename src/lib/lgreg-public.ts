/**
 * Client-side helpers for the PUBLIC learning-group registration wizard
 * (anon Supabase client). Argument names match the deployed SQL signatures
 * EXACTLY (migration 20260921000004):
 *   public_lgreg_overview(text)
 *   public_lgreg_students(text, uuid)
 *   public_lgreg_registration(text, uuid)
 *   public_lgreg_submit(text, uuid, uuid, uuid[])
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

export interface PublicLgregSlot {
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface PublicLgregGroup {
  id: string;
  name: string;
  description: string | null;
  slots: PublicLgregSlot[];
  staff_leader_names: string[];
  student_leader_names: string[];
}

export interface LgregSubmitResult {
  status: "ok" | "invalid" | "not_open" | "closed" | "error";
  message?: string;
}

export interface LgregExisting {
  status: "ok" | "none" | "unavailable";
  selected?: string[];
}

function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export async function fetchLgregStudents(
  supabase: AnyClient,
  token: string,
  groupId: string
): Promise<{ id: string; first_name: string; last_name: string }[]> {
  const { data } = await supabase.rpc("public_lgreg_students", {
    p_token: token,
    p_group_id: groupId,
  });
  return asArray(data);
}

export async function fetchLgregExisting(
  supabase: AnyClient,
  token: string,
  studentId: string
): Promise<LgregExisting> {
  const { data } = await supabase.rpc("public_lgreg_registration", {
    p_token: token,
    p_student_id: studentId,
  });
  const res = (data ?? {}) as LgregExisting;
  return {
    status: res.status ?? "unavailable",
    selected: Array.isArray(res.selected) ? res.selected : undefined,
  };
}

export async function submitLgreg(
  supabase: AnyClient,
  input: {
    token: string;
    studentId: string;
    homeGroupId: string;
    selectedGroupIds: string[];
  }
): Promise<LgregSubmitResult> {
  const { data } = await supabase.rpc("public_lgreg_submit", {
    p_token: input.token,
    p_student_id: input.studentId,
    p_home_group_id: input.homeGroupId,
    p_selected_group_ids: input.selectedGroupIds,
  });
  const res = (data ?? {}) as LgregSubmitResult;
  return { status: res.status ?? "error", message: res.message };
}
