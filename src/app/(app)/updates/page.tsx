import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import UpdatesList, { type UpdateItem } from "@/components/updates/UpdatesList";

export const metadata = { title: "עדכונים שלא נקראו" };

export default async function UpdatesPage() {
  await requireMe();
  const supabase = await createClient();

  // all messages readable by the current staff member WITH their persisted
  // per-user read state (client tabs filter all/unread/read)
  const { data: rows, error } = await supabase.rpc("staff_message_updates", {
    p_limit: 200,
  });
  if (error) {
    console.error("[/updates] staff_message_updates failed:", error);
  }

  const items: UpdateItem[] = ((rows ?? []) as Array<{
    message_id: string;
    student_id: string;
    student_first_name: string;
    student_last_name: string;
    author_name: string | null;
    body: string;
    created_at: string;
    read: boolean;
  }>).map((r) => ({
    message_id: r.message_id,
    student_id: r.student_id,
    student_first_name: r.student_first_name,
    student_last_name: r.student_last_name,
    author_name: r.author_name,
    body: r.body,
    created_at: r.created_at,
    read: r.read,
  }));

  return <UpdatesList items={items} />;
}
