-- ============================================================================
-- Migration 20260923000004: PERFORMANCE — hot request paths
--
-- Additive only. No table, policy, grant-scope or visibility-rule changes.
--
-- 1. student_unread_counts()   — REDEFINED (create or replace), same
--    signature/result. Runs on EVERY authenticated page (nav badge).
-- 2. staff_message_updates(int) — REDEFINED (create or replace), same
--    signature/result. The /updates feed.
--
--    Both evaluated the read-permission helpers (staff_is_privileged,
--    is_student_mentor, is_assigned_master, is_major_head_for_student) once
--    PER MESSAGE. SECURITY DEFINER helpers are never inlined, so every
--    message paid ~4 sub-queries (EXPLAIN: 61k buffer hits, ~160 ms for
--    ~5k messages as a mentor).
--
--    The deployed predicate depends only on (staff, student) plus the
--    message's own flags, so the helpers are now evaluated ONCE PER STUDENT
--    in a MATERIALIZED CTE (materialized: otherwise the planner inlines the
--    CTE and pushes the helper calls back into the per-message join filter)
--    and joined to the messages with a hash join. The visibility rule itself
--    is unchanged, term for term:
--      privileged OR mentor                                  -> full access
--      NOT hidden_from_leads AND (assigned master OR major head)
--      OR is_general_visible
--    Verified row-for-row identical (including order and read flags) for
--    every staff account before/after; see
--    supabase/tests/performance_equivalence_tests.sql.
--
-- 3. current_staff_context() — NEW read-only RPC. The caller's own staff
--    identity + roles + canonical relationships in ONE round trip (the app
--    previously resolved profile -> roles -> group_mentors sequentially on
--    every request, each a full network round trip to the database).
--    Scoped strictly to auth.uid(); returns nothing for anon / unlinked
--    accounts. For an INACTIVE profile it returns the profile row with empty
--    roles/relationships — exactly what the RLS-scoped queries it replaces
--    returned (profiles_select_self_or_staff lets a user read their own row;
--    user_roles/group_mentors/master_assignments require an active staff
--    member), so callers keep redirecting inactive accounts to
--    /access-denied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. student_unread_counts — per-student unread totals (nav badge, chips)
-- ---------------------------------------------------------------------------
create or replace function public.student_unread_counts()
returns table (student_id uuid, unread_count bigint)
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
  select m.student_id, count(*)::bigint as unread_count
    from public.student_messages m
    join vis on vis.student_id = m.student_id
   cross join me
   where not exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         )
     and (
       vis.full_access
       or (not m.is_hidden_from_leads and vis.lead_access)
       or m.is_general_visible
     )
   group by m.student_id;
$$;

-- ---------------------------------------------------------------------------
-- 2. staff_message_updates — /updates feed with persisted read state
-- ---------------------------------------------------------------------------
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
  with me as (
    select public.current_staff_id() as sid
  ),
  vis as materialized (
    -- the read-permission helpers, evaluated ONCE per student
    select s.id as student_id, s.first_name, s.last_name,
           (public.staff_is_privileged(me.sid)
            or public.is_student_mentor(me.sid, s.id)) as full_access,
           (public.is_assigned_master(me.sid, s.id)
            or public.is_major_head_for_student(me.sid, s.id)) as lead_access
      from public.students s, me
     where me.sid is not null
  )
  select m.id, vis.student_id, vis.first_name, vis.last_name,
         m.author_staff_id, p.full_name, m.body, m.created_at,
         m.is_general_visible, m.is_hidden_from_leads,
         exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         ) as read
    from public.student_messages m
    join vis on vis.student_id = m.student_id
    join public.profiles p on p.id = m.author_staff_id
   cross join me
   where m.deleted_at is null
     and (
       vis.full_access
       or (not m.is_hidden_from_leads and vis.lead_access)
       or m.is_general_visible
     )
   order by m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

-- ---------------------------------------------------------------------------
-- 3. current_staff_context — the caller's identity in one round trip
-- ---------------------------------------------------------------------------
create or replace function public.current_staff_context()
returns table (
  staff_id           uuid,
  email              text,
  full_name          text,
  avatar_url         text,
  is_active          boolean,
  roles              public.app_role[],
  mentor_group_ids   uuid[],
  master_student_ids uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.email,
         p.full_name,
         p.avatar_url,
         p.is_active,
         case when p.is_active then coalesce(
           (select array_agg(ur.role order by ur.created_at, ur.role)
              from public.user_roles ur
             where ur.staff_id = p.id), '{}') else '{}' end,
         case when p.is_active then coalesce(
           (select array_agg(gm.group_id order by g.name, gm.group_id)
              from public.group_mentors gm
              join public.greenhouse_groups g on g.id = gm.group_id
             where gm.staff_id = p.id), '{}') else '{}' end,
         case when p.is_active then coalesce(
           (select array_agg(ma.student_id order by ma.student_id)
              from public.master_assignments ma
             where ma.staff_id = p.id), '{}') else '{}' end
    from public.profiles p
   where auth.uid() is not null
     and p.auth_user_id = auth.uid()
   limit 1;
$$;

revoke all on function public.current_staff_context() from public, anon;
grant execute on function public.current_staff_context() to authenticated;
