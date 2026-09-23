import { requireMe } from "@/lib/auth";
import { fetchUpdatesPage, parseUpdatesFilter } from "@/lib/updates";
import { getUnreadCounts, totalUnread } from "@/lib/unread";
import UpdatesList from "@/components/updates/UpdatesList";

export const metadata = { title: "עדכונים" };

export default async function UpdatesPage({
  searchParams,
}: PageProps<"/updates">) {
  const { filter: filterParam } = await searchParams;
  const filter = parseUpdatesFilter(filterParam);

  // first bounded page of the selected filter (server-side keyset paging)
  // plus the canonical unread total — the same count as the nav badge. Both
  // RPCs are keyed by auth.uid() inside the database, so they run together
  // with the shared identity check; nothing is rendered before requireMe().
  const [, page, unreadByStudent] = await Promise.all([
    requireMe(),
    fetchUpdatesPage(filter, null),
    getUnreadCounts(),
  ]);

  return (
    <UpdatesList
      key={filter}
      filter={filter}
      initialItems={page.items}
      initialCursor={page.nextCursor}
      totalUnread={totalUnread(unreadByStudent)}
    />
  );
}
