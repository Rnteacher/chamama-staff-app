-- ============================================================================
-- Performance migration equivalence tests (migration 20260923000004).
--   supabase db reset && psql -f supabase/tests/performance_equivalence_tests.sql
--
-- The migration rewrote student_unread_counts() and staff_message_updates()
-- for speed (read-permission helpers evaluated once per student instead of
-- once per message) and added current_staff_context(). These tests pin the
-- rewritten functions to the PRE-MIGRATION definitions (embedded below as
-- reference implementations) for every staff account, over a message set
-- that covers every visibility-flag combination for every student.
--
-- Migration 20260923000006 then INTENTIONALLY changed one semantic so the
-- unread badge equals /updates "לא נקראו": soft-deleted messages are no
-- longer counted as unread. The unread reference carries exactly that change
-- (marked "000006") and nothing else; staff_message_updates() is unchanged.
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

\echo '--- starting performance equivalence test suite ---'

-- ============================================================================
-- PE1: student_unread_counts + staff_message_updates == deployed definitions
-- ============================================================================
begin;

-- reference: student_unread_counts as deployed before 20260923000004
-- (+ 000006: soft-deleted messages are not unread updates)
create function pg_temp.ref_unread()
returns table (student_id uuid, unread_count bigint)
language sql stable as $$
  with me as (select public.current_staff_id() as sid)
  select m.student_id, count(*)::bigint as unread_count
    from public.student_messages m, me
   where me.sid is not null
     and m.deleted_at is null -- 000006
     and not exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         )
     and (
       public.staff_is_privileged(me.sid)
       or public.is_student_mentor(me.sid, m.student_id)
       or (
         not m.is_hidden_from_leads
         and (
           public.is_assigned_master(me.sid, m.student_id)
           or public.is_major_head_for_student(me.sid, m.student_id)
         )
       )
       or m.is_general_visible
     )
   group by m.student_id;
$$;

-- reference: staff_message_updates as deployed before 20260923000004
create function pg_temp.ref_updates(p_limit int default 200)
returns table (
  message_id uuid, student_id uuid, student_first_name text, student_last_name text,
  author_staff_id uuid, author_name text, body text, created_at timestamptz,
  is_general_visible boolean, is_hidden_from_leads boolean, read boolean)
language sql stable as $$
  with me as (select public.current_staff_id() as sid)
  select m.id, s.id, s.first_name, s.last_name,
         m.author_staff_id, p.full_name, m.body, m.created_at,
         m.is_general_visible, m.is_hidden_from_leads,
         exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         ) as read
    from public.student_messages m
    join public.students s on s.id = m.student_id
    join public.profiles p on p.id = m.author_staff_id
   cross join me
   where me.sid is not null
     and m.deleted_at is null
     and (
       public.staff_is_privileged(me.sid)
       or public.is_student_mentor(me.sid, m.student_id)
       or (
         not m.is_hidden_from_leads
         and (
           public.is_assigned_master(me.sid, m.student_id)
           or public.is_major_head_for_student(me.sid, m.student_id)
         )
       )
       or m.is_general_visible
     )
   order by m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

-- every visibility combination (general × hidden-from-leads × soft-deleted)
-- for every student, plus partial read state for every staff member
set local session_replication_role = replica; -- bulk fixture: skip guards
insert into public.student_messages
  (student_id, author_staff_id, body, created_at, is_general_visible,
   is_hidden_from_leads, deleted_at)
select s.id,
       (select id from public.profiles order by id limit 1),
       'perf-eq ' || g::text || h::text || d::text,
       now() - make_interval(secs => (row_number() over ())::int),
       g, h, case when d then now() end
  from public.students s,
       (values (false), (true)) gv(g),
       (values (false), (true)) hv(h),
       (values (false), (true)) dv(d);
insert into public.message_reads (staff_id, message_id)
select p.id, m.id
  from public.profiles p
  join public.student_messages m on m.body like 'perf-eq %'
 where (hashtext(p.id::text || m.id::text) % 3) = 0
on conflict do nothing;
set local session_replication_role = origin;

do $$
declare
  r record;
  v_diff bigint;
  v_o1 text;
  v_o2 text;
  v_checked int := 0;
begin
  for r in select id, auth_user_id, email from public.profiles
            where auth_user_id is not null order by email loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.auth_user_id, 'role', 'authenticated')::text, true);

    select count(*) into v_diff from (
      (select * from public.student_unread_counts() except select * from pg_temp.ref_unread())
      union all
      (select * from pg_temp.ref_unread() except select * from public.student_unread_counts())
    ) x;
    if v_diff <> 0 then
      raise exception 'FAIL: student_unread_counts differs from the deployed definition for % (% rows)', r.email, v_diff;
    end if;

    select count(*) into v_diff from (
      (select * from public.staff_message_updates(500) except select * from pg_temp.ref_updates(500))
      union all
      (select * from pg_temp.ref_updates(500) except select * from public.staff_message_updates(500))
    ) y;
    if v_diff <> 0 then
      raise exception 'FAIL: staff_message_updates differs from the deployed definition for % (% rows)', r.email, v_diff;
    end if;

    -- same page, same order, same read flags at the default limit too
    select string_agg(message_id::text || ':' || read::text, ',' order by n)
      into v_o1 from (select *, row_number() over () n from public.staff_message_updates(5)) a;
    select string_agg(message_id::text || ':' || read::text, ',' order by n)
      into v_o2 from (select *, row_number() over () n from pg_temp.ref_updates(5)) b;
    if v_o1 is distinct from v_o2 then
      raise exception 'FAIL: staff_message_updates page/order differs for %', r.email;
    end if;
    v_checked := v_checked + 1;
  end loop;
  if v_checked < 5 then
    raise exception 'FAIL: expected the seeded staff accounts, checked only %', v_checked;
  end if;
  raise notice 'PASS: unread counts + updates feed identical to deployed definitions for % accounts', v_checked;
end $$;

-- anonymous / unlinked callers still get nothing
do $$ begin
  perform set_config('request.jwt.claims', '', true);
  if exists (select 1 from public.student_unread_counts())
     or exists (select 1 from public.staff_message_updates(50)) then
    raise exception 'FAIL: anonymous caller received message data';
  end if;
  raise notice 'PASS: anonymous caller receives no unread counts / updates';
end $$;
rollback;

-- ============================================================================
-- PE2: current_staff_context == the RLS-scoped queries it replaces
-- ============================================================================
begin;
do $$
declare
  r record;
  c record;
  v_checked int := 0;
begin
  for r in select * from public.profiles where auth_user_id is not null order by email loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.auth_user_id, 'role', 'authenticated')::text, true);
    select * into c from public.current_staff_context();
    if c.staff_id is distinct from r.id or c.email is distinct from r.email
       or c.full_name is distinct from r.full_name or c.is_active is distinct from r.is_active then
      raise exception 'FAIL: current_staff_context identity mismatch for %', r.email;
    end if;
    if r.is_active then
      if (select coalesce(array_agg(role order by role), '{}') from public.user_roles where staff_id = r.id)
         is distinct from (select coalesce(array_agg(x order by x), '{}') from unnest(c.roles) x) then
        raise exception 'FAIL: roles mismatch for %', r.email;
      end if;
      if (select coalesce(array_agg(group_id order by group_id), '{}') from public.group_mentors where staff_id = r.id)
         is distinct from (select coalesce(array_agg(x order by x), '{}') from unnest(c.mentor_group_ids) x) then
        raise exception 'FAIL: mentor groups mismatch for %', r.email;
      end if;
      if (select coalesce(array_agg(student_id order by student_id), '{}') from public.master_assignments where staff_id = r.id)
         is distinct from (select coalesce(array_agg(x order by x), '{}') from unnest(c.master_student_ids) x) then
        raise exception 'FAIL: master students mismatch for %', r.email;
      end if;
    else
      -- inactive: the replaced RLS-scoped queries returned no roles/relations
      if cardinality(c.roles) <> 0 or cardinality(c.mentor_group_ids) <> 0
         or cardinality(c.master_student_ids) <> 0 then
        raise exception 'FAIL: inactive account % received roles/relationships', r.email;
      end if;
    end if;
    v_checked := v_checked + 1;
  end loop;
  raise notice 'PASS: current_staff_context matches profile/roles/relationships for % accounts', v_checked;
end $$;

do $$ begin
  perform set_config('request.jwt.claims', '', true);
  if exists (select 1 from public.current_staff_context()) then
    raise exception 'FAIL: current_staff_context returned a row without auth.uid()';
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  if exists (select 1 from public.current_staff_context()) then
    raise exception 'FAIL: current_staff_context returned a row for an unlinked account';
  end if;
  raise notice 'PASS: current_staff_context is empty for anonymous / unlinked accounts';
end $$;

do $$ begin
  if has_function_privilege('anon', 'public.current_staff_context()', 'execute') then
    raise exception 'FAIL: anon may execute current_staff_context';
  end if;
  if not has_function_privilege('authenticated', 'public.current_staff_context()', 'execute') then
    raise exception 'FAIL: authenticated may not execute current_staff_context';
  end if;
  raise notice 'PASS: current_staff_context grants (authenticated only)';
end $$;
rollback;

do $$ begin
  perform set_config('request.jwt.claims', '', true);
end $$;
\echo '--- performance equivalence test suite finished ---'
