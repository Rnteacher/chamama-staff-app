import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Per-student unread counts for the current staff member (RLS-scoped
 * SECURITY DEFINER RPC keyed by auth.uid(); empty for anyone else).
 *
 * Request-scoped (React cache): the layout's nav badge and the page's
 * per-student / per-group badges share ONE database call per request. It
 * depends on nothing but the session, so callers may start it before their
 * identity check resolves; its data is only rendered after that check.
 */
export const getUnreadCounts = cache(
  async (): Promise<ReadonlyMap<string, number>> => {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("student_unread_counts");
    if (error) console.error("[unread] student_unread_counts failed:", error.message);
    const byStudent = new Map<string, number>();
    for (const row of (data ?? []) as Array<{ student_id: string; unread_count: number }>) {
      byStudent.set(row.student_id, Number(row.unread_count));
    }
    return byStudent;
  }
);

export function totalUnread(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const n of counts.values()) sum += n;
  return sum;
}
