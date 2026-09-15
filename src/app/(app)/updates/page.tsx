import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/format";
import EmptyState from "@/components/EmptyState";
import MarkAllReadButton from "@/components/MarkAllReadButton";

export const metadata = { title: "עדכונים שלא נקראו" };

export default async function UpdatesPage() {
  await requireMe();
  const supabase = await createClient();

  const { data: rows } = await supabase.rpc("unread_messages", {
    p_limit: 100,
    p_offset: 0,
  });

  const unread = (rows ?? []) as Array<{
    message_id: string;
    student_id: string;
    student_first_name: string;
    student_last_name: string;
    author_name: string | null;
    body: string;
    created_at: string;
  }>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold">עדכונים שלא נקראו</h1>
        {unread.length > 0 && (
          <MarkAllReadButton
            messageIds={unread.map((u) => u.message_id)}
            label={`סמן הכל כנקרא (${unread.length})`}
          />
        )}
      </div>

      {unread.length === 0 ? (
        <EmptyState
          title="אין עדכונים שלא נקראו"
          description="כל העדכונים הרלוונטיים אליכם נקראו. עדכון חדש יופיע כאן."
          action={
            <Link
              href="/"
              className="rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-ink"
            >
              חזרה לדף הבית
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {unread.map((row) => (
            <li key={row.message_id}>
              <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-dark"
                />
                <Link
                  href={`/students/${row.student_id}?m=${row.message_id}`}
                  className="min-w-0 flex-1"
                >
                  <span className="block font-bold">
                    {row.student_first_name} {row.student_last_name}
                  </span>
                  <span className="mt-0.5 block text-sm leading-6 text-ink/90 line-clamp-3">
                    {row.body}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    {row.author_name ?? "צוות"} · {timeAgo(row.created_at)}
                  </span>
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
