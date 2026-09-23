-- ============================================================================
-- Unread badge consistency + /updates paging tests (migration 20260923000006).
--   supabase db reset && psql -f supabase/tests/unread_consistency_tests.sql
--
-- The bottom-nav badge is the sum of student_unread_counts() (ALL unread).
-- /updates "לא נקראו" pages through staff_message_updates_page('unread').
-- Paging to the end must expose exactly the set the badge counts; pages are
-- bounded; mark-all marks the whole canonical unread set.
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

\echo '--- starting unread consistency test suite ---'

-- act as a staff member's signed-in account
create or replace function pg_temp.act_as(p_email text)
returns void language plpgsql as $$
declare v_uid uuid;
begin
  select auth_user_id into v_uid from public.profiles where email = p_email;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
end;
$$;

-- badge value (what the layout renders)
create or replace function pg_temp.badge()
returns bigint language sql as $$
  select coalesce(sum(unread_count), 0)::bigint from public.student_unread_counts();
$$;

-- page through a /updates filter the way the UI does (page size 50, asks 51)
-- and collect every row; fails on duplicates or unbounded pages
create or replace function pg_temp.all_pages(p_filter text)
returns table (message_id uuid, student_id uuid, read boolean)
language plpgsql as $$
declare
  v_created timestamptz := null;
  v_id uuid := null;
  v_rows int;
  v_guard int := 0;
begin
  create temp table if not exists pg_temp_pages (message_id uuid, student_id uuid, read boolean, created_at timestamptz);
  truncate pg_temp_pages;
  loop
    v_guard := v_guard + 1;
    if v_guard > 1000 then raise exception 'FAIL: paging did not terminate'; end if;
    with pg as (
      select * from public.staff_message_updates_page(p_filter, v_created, v_id, 51)
    ), ins as (
      insert into pg_temp_pages
      select pg.message_id, pg.student_id, pg.read, pg.created_at
        from pg order by pg.created_at desc, pg.message_id desc limit 50
      returning 1
    )
    select count(*) into v_rows from pg;
    if v_rows > 51 then raise exception 'FAIL: page larger than requested (%)', v_rows; end if;
    exit when v_rows <= 50;
    select t.created_at, t.message_id into v_created, v_id
      from pg_temp_pages t order by t.created_at asc, t.message_id asc limit 1;
  end loop;
  if (select count(*) from pg_temp_pages) <> (select count(distinct t.message_id) from pg_temp_pages t) then
    raise exception 'FAIL: paging returned duplicate rows';
  end if;
  return query select t.message_id, t.student_id, t.read from pg_temp_pages t;
end;
$$;

create or replace function pg_temp.unread_tab()
returns bigint language sql as $$
  select count(*)::bigint from pg_temp.all_pages('unread');
$$;

-- ============================================================================
-- UC1: 0 unread -> 0; 1 unread -> 1; 3 unread -> 3; last one read -> 0
-- ============================================================================
begin;
select pg_temp.act_as('michal@chamama.example');
do $$
declare
  v_sid uuid := public.current_staff_id();
  v_ids uuid[];
begin
  perform public.staff_mark_all_updates_read();
  if pg_temp.badge() <> 0 or pg_temp.unread_tab() <> 0 then
    raise exception 'FAIL: 0 unread expected (badge=%, tab=%)', pg_temp.badge(), pg_temp.unread_tab();
  end if;
  if exists (select 1 from public.student_unread_counts()) then
    raise exception 'FAIL: 0 unread must return no per-student rows';
  end if;

  select array_agg(message_id) into v_ids
    from (select message_id from public.staff_message_updates_page('all', null, null, 3)) t;

  delete from public.message_reads where staff_id = v_sid and message_id = v_ids[1];
  if pg_temp.badge() <> 1 or pg_temp.unread_tab() <> 1 then
    raise exception 'FAIL: 1 unread expected (badge=%, tab=%)', pg_temp.badge(), pg_temp.unread_tab();
  end if;

  delete from public.message_reads where staff_id = v_sid and message_id = any (v_ids);
  if pg_temp.badge() <> 3 or pg_temp.unread_tab() <> 3 then
    raise exception 'FAIL: 3 unread expected (badge=%, tab=%)', pg_temp.badge(), pg_temp.unread_tab();
  end if;

  insert into public.message_reads (staff_id, message_id) select v_sid, unnest(v_ids);
  if pg_temp.badge() <> 0 or pg_temp.unread_tab() <> 0 then
    raise exception 'FAIL: marking the last unread read must clear the badge (badge=%)', pg_temp.badge();
  end if;
  raise notice 'PASS: badge 0 -> 1 -> 3 -> 0 tracks the /updates unread tab exactly';
end $$;
rollback;

-- ============================================================================
-- UC2: a soft-deleted unread message never contributes (root cause)
-- ============================================================================
begin;
select pg_temp.act_as('michal@chamama.example');
do $$
declare
  v_sid uuid := public.current_staff_id();
  v_student uuid;
  v_msg uuid;
begin
  perform public.staff_mark_all_updates_read();
  select s.id into v_student from public.students s
   where public.is_student_mentor(v_sid, s.id) limit 1;
  set local session_replication_role = replica; -- fixture: skip author guards
  insert into public.student_messages (student_id, author_staff_id, body, deleted_at)
  values (v_student, (select id from public.profiles where email = 'yoav@chamama.example'),
          'uc2 deleted before it was read', now())
  returning id into v_msg;
  set local session_replication_role = origin;
  if pg_temp.badge() <> 0 or pg_temp.unread_tab() <> 0 then
    raise exception 'FAIL: deleted message counted as unread (badge=%, tab=%)', pg_temp.badge(), pg_temp.unread_tab();
  end if;
  if exists (select 1 from pg_temp.all_pages('all') where message_id = v_msg) then
    raise exception 'FAIL: deleted message listed on /updates';
  end if;
  raise notice 'PASS: a deleted message never contributes to the badge or the list';
end $$;
rollback;

-- ============================================================================
-- UC3: 250 unread — badge 250, first page bounded, paging exposes all 250
--      exactly once, mark-all marks all 250 and clears the badge
-- ============================================================================
begin;
select pg_temp.act_as('michal@chamama.example');
do $$
declare
  v_sid uuid := public.current_staff_id();
  v_student uuid;
  v_first int;
  v_marked int;
begin
  perform public.staff_mark_all_updates_read();
  select s.id into v_student from public.students s
   where public.is_student_mentor(v_sid, s.id) limit 1;
  set local session_replication_role = replica;
  -- 245 at distinct times + 5 sharing one timestamp (keyset ties) = 250
  insert into public.student_messages (student_id, author_staff_id, body, created_at)
  select v_student, (select id from public.profiles where email = 'yoav@chamama.example'),
         'uc3 unread ' || g, now() - make_interval(mins => g)
    from generate_series(1, 245) g;
  insert into public.student_messages (student_id, author_staff_id, body, created_at)
  select v_student, (select id from public.profiles where email = 'yoav@chamama.example'),
         'uc3 tie ' || g, now() - interval '1 year'
    from generate_series(1, 5) g;
  set local session_replication_role = origin;

  if pg_temp.badge() <> 250 then
    raise exception 'FAIL: badge should reflect 250 unread, got %', pg_temp.badge();
  end if;
  select count(*) into v_first from public.staff_message_updates_page('unread', null, null, 51);
  if v_first <> 51 then
    raise exception 'FAIL: first unread page must be bounded (51 incl. look-ahead), got %', v_first;
  end if;
  if (select count(*) from public.staff_message_updates_page('unread', null, null, 100000)) > 101 then
    raise exception 'FAIL: page size is not clamped';
  end if;
  if pg_temp.unread_tab() <> 250 then
    raise exception 'FAIL: paging must expose every unread item, got %', pg_temp.unread_tab();
  end if;
  if exists (select 1 from pg_temp.all_pages('unread') p where p.read) then
    raise exception 'FAIL: unread filter returned read rows';
  end if;

  v_marked := public.staff_mark_all_updates_read();
  if v_marked <> 250 then
    raise exception 'FAIL: mark-all should mark 250, marked %', v_marked;
  end if;
  if pg_temp.badge() <> 0 or pg_temp.unread_tab() <> 0 then
    raise exception 'FAIL: after mark-all badge=% tab=%', pg_temp.badge(), pg_temp.unread_tab();
  end if;
  raise notice 'PASS: 250 unread — badge 250, first page bounded, paging complete (no dup), mark-all clears all';
end $$;
rollback;

-- ============================================================================
-- UC4: for EVERY staff account — per-student counts == unread rows reachable
--      by paging; all == unread + read; deleted never listed
-- ============================================================================
begin;
set local session_replication_role = replica;
insert into public.student_messages
  (student_id, author_staff_id, body, created_at, is_general_visible,
   is_hidden_from_leads, deleted_at)
select s.id, (select id from public.profiles order by id limit 1),
       'uc4 ' || g::text || h::text || d::text,
       now() - make_interval(secs => (row_number() over ())::int),
       g, h, case when d then now() end
  from public.students s,
       (values (false), (true)) gv(g),
       (values (false), (true)) hv(h),
       (values (false), (true)) dv(d);
insert into public.message_reads (staff_id, message_id)
select p.id, m.id from public.profiles p
  join public.student_messages m on m.body like 'uc4 %'
 where (hashtext(p.id::text || m.id::text) % 3) = 0
on conflict do nothing;
set local session_replication_role = origin;
do $$
declare r record; v_diff bigint; v_checked int := 0;
begin
  for r in select email from public.profiles where auth_user_id is not null order by email loop
    perform pg_temp.act_as(r.email);
    select count(*) into v_diff from (
      (select student_id, unread_count from public.student_unread_counts()
       except
       select student_id, count(*)::bigint from pg_temp.all_pages('unread') group by student_id)
      union all
      (select student_id, count(*)::bigint from pg_temp.all_pages('unread') group by student_id
       except
       select student_id, unread_count from public.student_unread_counts())
    ) x;
    if v_diff <> 0 then
      raise exception 'FAIL: per-student unread counts differ from /updates paging for % (% rows)', r.email, v_diff;
    end if;
    if (select count(*) from pg_temp.all_pages('all'))
       <> (select count(*) from pg_temp.all_pages('unread')) + (select count(*) from pg_temp.all_pages('read')) then
      raise exception 'FAIL: all <> unread + read for %', r.email;
    end if;
    if exists (select 1 from pg_temp.all_pages('all') p
                join public.student_messages m on m.id = p.message_id
               where m.deleted_at is not null) then
      raise exception 'FAIL: /updates lists a deleted message for %', r.email;
    end if;
    v_checked := v_checked + 1;
  end loop;
  if v_checked < 5 then
    raise exception 'FAIL: expected the seeded staff accounts, checked only %', v_checked;
  end if;
  raise notice 'PASS: per-student unread counts == /updates unread pages; all = unread + read (% accounts)', v_checked;
end $$;
rollback;

-- ============================================================================
-- UC5: anonymous gets nothing and cannot mark; helper internal-only; grants
-- ============================================================================
begin;
do $$
begin
  perform set_config('request.jwt.claims', '', true);
  if exists (select 1 from public.student_unread_counts())
     or exists (select 1 from public.staff_message_updates_page('all', null, null, 51)) then
    raise exception 'FAIL: anonymous caller received message data';
  end if;
  begin
    perform public.staff_mark_all_updates_read();
    raise exception 'FAIL: anonymous mark-all succeeded';
  exception when insufficient_privilege then null;
  end;
  if has_function_privilege('authenticated', 'public.staff_visible_messages()', 'execute')
     or has_function_privilege('anon', 'public.staff_visible_messages()', 'execute') then
    raise exception 'FAIL: staff_visible_messages() is executable by clients';
  end if;
  if has_function_privilege('anon', 'public.staff_message_updates_page(text,timestamptz,uuid,integer)', 'execute')
     or has_function_privilege('anon', 'public.staff_mark_all_updates_read()', 'execute') then
    raise exception 'FAIL: anon may execute the /updates RPCs';
  end if;
  if not has_function_privilege('authenticated', 'public.student_unread_counts()', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_message_updates_page(text,timestamptz,uuid,integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_mark_all_updates_read()', 'execute') then
    raise exception 'FAIL: authenticated lost access to the unread RPCs';
  end if;
  raise notice 'PASS: anonymous gets nothing / cannot mark; helper internal-only; grants correct';
end $$;
rollback;

-- ============================================================================
-- UC6: mark-all touches only the caller's own read rows
-- ============================================================================
begin;
do $$
declare v_other bigint; v_after bigint;
begin
  select count(*) into v_other from public.message_reads r
    join public.profiles p on p.id = r.staff_id where p.email <> 'michal@chamama.example';
  perform pg_temp.act_as('michal@chamama.example');
  perform public.staff_mark_all_updates_read();
  select count(*) into v_after from public.message_reads r
    join public.profiles p on p.id = r.staff_id where p.email <> 'michal@chamama.example';
  if v_after <> v_other then
    raise exception 'FAIL: mark-all changed other staff members'' read state';
  end if;
  raise notice 'PASS: mark-all writes only the caller''s own read rows';
end $$;
rollback;

\echo '--- unread consistency test suite finished ---'
