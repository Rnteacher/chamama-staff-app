import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  UpdateItem,
  UpdatesCursor,
  UpdatesFilter,
} from "@/lib/updates-types";

/** Items per /updates page (the RPC is asked for one extra to detect more). */
export const UPDATES_PAGE_SIZE = 50;

export function parseUpdatesFilter(value: unknown): UpdatesFilter {
  return value === "unread" || value === "read" ? value : "all";
}

/**
 * One server-side page of the current staff member's updates
 * (staff_message_updates_page — the canonical visible set, keyed by
 * auth.uid()). Returns at most UPDATES_PAGE_SIZE items plus the keyset
 * cursor of the next page, or null when this was the last page.
 */
export async function fetchUpdatesPage(
  filter: UpdatesFilter,
  cursor: UpdatesCursor | null
): Promise<{ items: UpdateItem[]; nextCursor: UpdatesCursor | null; error: boolean }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_message_updates_page", {
    p_filter: filter,
    p_before_created_at: cursor?.createdAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_limit: UPDATES_PAGE_SIZE + 1,
  });
  if (error) {
    console.error("[/updates] staff_message_updates_page failed:", error.message);
    return { items: [], nextCursor: null, error: true };
  }
  const rows = (data ?? []) as Array<{
    message_id: string;
    student_id: string;
    student_first_name: string;
    student_last_name: string;
    author_name: string | null;
    body: string;
    created_at: string;
    read: boolean;
  }>;
  const page = rows.slice(0, UPDATES_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      message_id: r.message_id,
      student_id: r.student_id,
      student_first_name: r.student_first_name,
      student_last_name: r.student_last_name,
      author_name: r.author_name,
      body: r.body,
      created_at: r.created_at,
      read: r.read,
    })),
    nextCursor:
      rows.length > UPDATES_PAGE_SIZE && last
        ? { createdAt: last.created_at, id: last.message_id }
        : null,
    error: false,
  };
}
