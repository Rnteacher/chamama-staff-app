-- ============================================================================
-- Unread badge == /updates "לא נקראו", with server-side paging (additive;
-- redefines two RPCs with the same signatures and adds three functions).
--
-- Bug: the bottom-nav badge (and the per-student unread badges) come from
-- student_unread_counts(), while /updates listed staff_message_updates().
-- The two disagreed in two ways:
--   1. student_unread_counts() counted SOFT-DELETED messages
--      (student_messages.deleted_at is not null). /updates never shows them,
--      so a message deleted before the viewer read it kept the badge at 1
--      forever while the unread tab was empty — and it could never be
--      marked read from the UI.
--   2. /updates showed only the newest 200 messages, so an unread message
--      older than that was counted but never listed, and "mark all as read"
--      (which sent the listed ids) could not reach it.
--
-- Fix: ONE canonical definition of "an update the caller sees":
--   staff_visible_messages() — the caller's visible, non-deleted messages with
--   their per-user read state (same visibility rules as before: privileged /
--   mentor full access; master / major head unless hidden from leads; general
--   visible to all staff). Built on it:
--   * student_unread_counts()       — ALL unread rows, grouped by student
--                                     (nav badge + per-student badges).
--   * staff_message_updates_page()  — /updates, keyset-paged per filter
--                                     (all / unread / read): bounded pages, and
--                                     every item is reachable by paging on.
--   * staff_mark_all_updates_read() — marks the WHOLE canonical unread set read,
--                                     not just the loaded page.
--   * staff_message_updates(p_limit) — kept for compatibility (newest window),
--                                     now on the same canonical set.
-- Nothing here widens visibility: the helper is not callable by clients; the
-- new RPCs are keyed by auth.uid() and granted to authenticated only.
-- ============================================================================

create or replace function public.staff_visible_messages()
returns table (
  message_id uuid,
  student_id uuid,
  created_at timestamptz,
  read       boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select public.current_staff_id() as sid
  ),
  vis as materialized (
    -- the read-permission helpers, evaluated ONCE per student
    select s.id as student_id,
           (public.staff_is_privileged(me.sid)
            or public.is_student_mentor(me.sid, s.id)) as full_access,
           (public.is_assigned_master(me.sid, s.id)
            or public.is_major_head_for_student(me.sid, s.id)) as lead_access
      from public.students s, me
     where me.sid is not null
  )
  select m.id, m.student_id, m.created_at,
         exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         ) as read
    from public.student_messages m
    join vis on vis.student_id = m.student_id
   cross join me
   where m.deleted_at is null
     and (
       vis.full_access
       or (not m.is_hidden_from_leads and vis.lead_access)
       or m.is_general_visible
     );
$$;

-- internal building block: only the SECURITY DEFINER RPCs below call it
revoke all on function public.staff_visible_messages() from public, anon, authenticated;

create or replace function public.student_unread_counts()
returns table (student_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select v.student_id, count(*)::bigint as unread_count
    from public.staff_visible_messages() v
   where not v.read
   group by v.student_id;
$$;

create or replace function public.staff_message_updates(p_limit int default 200)
returns table (
  message_id           uuid,
  student_id           uuid,
  student_first_name   text,
  student_last_name    text,
  author_staff_id      uuid,
  author_name          text,
  body                 text,
  created_at           timestamptz,
  is_general_visible   boolean,
  is_hidden_from_leads boolean,
  read                 boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with v as (
    select sv.*,
           row_number() over (order by sv.created_at desc, sv.message_id desc) as rn
      from public.staff_visible_messages() sv
  )
  select m.id, s.id, s.first_name, s.last_name,
         m.author_staff_id, p.full_name, m.body, m.created_at,
         m.is_general_visible, m.is_hidden_from_leads,
         v.read
    from v
    join public.student_messages m on m.id = v.message_id
    join public.students s on s.id = v.student_id
    join public.profiles p on p.id = m.author_staff_id
   where v.rn <= greatest(1, least(coalesce(p_limit, 200), 500))
   order by m.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- /updates page: one bounded page of the caller's updates, newest first.
--   p_filter  'all' | 'unread' | 'read'
--   cursor    (p_before_created_at, p_before_id) of the last row already shown;
--             null = first page. Keyset order (created_at desc, id desc) is
--             stable while items are marked read/unread or new ones arrive.
--   p_limit   clamped to 1..101 (callers ask for page size + 1 to learn
--             whether another page exists).
-- ---------------------------------------------------------------------------
create or replace function public.staff_message_updates_page(
  p_filter            text        default 'all',
  p_before_created_at timestamptz default null,
  p_before_id         uuid        default null,
  p_limit             int         default 51
)
returns table (
  message_id           uuid,
  student_id           uuid,
  student_first_name   text,
  student_last_name    text,
  author_staff_id      uuid,
  author_name          text,
  body                 text,
  created_at           timestamptz,
  is_general_visible   boolean,
  is_hidden_from_leads boolean,
  read                 boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with page as (
    select sv.*
      from public.staff_visible_messages() sv
     where (coalesce(p_filter, 'all') = 'all'
            or (p_filter = 'unread' and not sv.read)
            or (p_filter = 'read' and sv.read))
       and (p_before_created_at is null
            or (sv.created_at, sv.message_id) < (p_before_created_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     order by sv.created_at desc, sv.message_id desc
     limit greatest(1, least(coalesce(p_limit, 51), 101))
  )
  select m.id, s.id, s.first_name, s.last_name,
         m.author_staff_id, p.full_name, m.body, m.created_at,
         m.is_general_visible, m.is_hidden_from_leads,
         page.read
    from page
    join public.student_messages m on m.id = page.message_id
    join public.students s on s.id = page.student_id
    join public.profiles p on p.id = m.author_staff_id
   order by m.created_at desc, m.id desc;
$$;

revoke all on function public.staff_message_updates_page(text, timestamptz, uuid, int) from public, anon;
grant execute on function public.staff_message_updates_page(text, timestamptz, uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- "סמן הכל כנקרא": marks EVERY unread update of the caller read (the whole
-- canonical unread set, not the loaded page). Returns how many were marked.
-- Only ever writes the caller's own read rows, only for messages the caller
-- can see (staff_visible_messages()).
-- ---------------------------------------------------------------------------
create or replace function public.staff_mark_all_updates_read()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_sid uuid := public.current_staff_id();
  v_n   integer;
begin
  if auth.uid() is null or v_sid is null then
    raise exception 'not an authorized staff member' using errcode = '42501';
  end if;
  insert into public.message_reads (staff_id, message_id)
  select v_sid, v.message_id
    from public.staff_visible_messages() v
   where not v.read
  on conflict (staff_id, message_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.staff_mark_all_updates_read() from public, anon;
grant execute on function public.staff_mark_all_updates_read() to authenticated;
