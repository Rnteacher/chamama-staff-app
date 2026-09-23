/** /updates list types, shared by the server page, actions and the client list. */

export type UpdatesFilter = "all" | "unread" | "read";

/** Keyset position: the (created_at, id) of the last item already shown. */
export interface UpdatesCursor {
  createdAt: string;
  id: string;
}

export interface UpdateItem {
  message_id: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  author_name: string | null;
  body: string;
  created_at: string;
  read: boolean;
}
