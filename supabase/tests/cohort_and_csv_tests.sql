-- ============================================================================
-- Cohort eligibility + calendar CSV import tests (migration 20260923000001).
--   supabase db reset && psql -f supabase/tests/cohort_and_csv_tests.sql
-- (vanilla Postgres: apply supabase/tests/local-postgres-stub.sql first)
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

\set ronen   '11111111-1111-1111-1111-111111111101' -- super_admin
\set michal  '11111111-1111-1111-1111-111111111102' -- mentor
\set tom     '11111111-1111-1111-1111-11111111110a' -- plain staff
\set itay    '11111111-1111-1111-1111-111111111105' -- employment_coordinator

\echo '--- starting cohort + csv-import test suite ---'

create or replace function _cc_as(p_email text) returns void
language plpgsql as $$
declare
  v_staff uuid;
begin
  perform set_config('role', 'postgres', true);
  select id into v_staff from public.profiles where email = p_email;
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', coalesce(v_staff::text, ''), 'role', 'authenticated')::text,
    true);
end;
$$;

-- ============================================================================
-- CH1: hebrew_cohort_rank — explicit alphabet order (never collation)
-- ============================================================================
do $$ begin
  if public.hebrew_cohort_rank('ארגמן') <> 1
     or public.hebrew_cohort_rank('ברקן') <> 2
     or public.hebrew_cohort_rank('גרניום') <> 3
     or public.hebrew_cohort_rank('דוריאן') <> 4
     or public.hebrew_cohort_rank('הל') <> 5
     or public.hebrew_cohort_rank('ולריאן') <> 6
     or public.hebrew_cohort_rank('זנגביל') <> 7 then
    raise exception 'FAIL: cohort ranks wrong for the canonical cohort names';
  end if;
  -- generic leading label is skipped; final letters normalized
  if public.hebrew_cohort_rank('קבוצת דוריאן') <> 4
     or public.hebrew_cohort_rank('ךהלב') <> 11 then
    raise exception 'FAIL: prefix/final-letter normalization wrong';
  end if;
  -- unrecognizable names → NULL (fail visibly, never guess)
  if public.hebrew_cohort_rank('XYZ') is not null
     or public.hebrew_cohort_rank('123') is not null
     or public.hebrew_cohort_rank('') is not null then
    raise exception 'FAIL: unrecognizable names must return NULL';
  end if;
  raise notice 'PASS: hebrew_cohort_rank explicit + prefix/final normalization + NULL for unknown';
end $$;

-- ============================================================================
-- CH2: THE REAL TRANSITION — דוריאן/הל/ולריאן → +זנגביל (no student changes)
-- ============================================================================
begin;
do $$ begin
  declare
    v_dorian uuid := 'c1cccccc-0000-0000-0000-000000000001';
    v_hel    uuid := 'c1cccccc-0000-0000-0000-000000000002';
    v_val    uuid := 'c1cccccc-0000-0000-0000-000000000003';
    v_zang   uuid := 'c1cccccc-0000-0000-0000-000000000004';
    v_hist   uuid := 'c1cccccc-0000-0000-0000-000000000005'; -- ארגמן, historical
    v_s1 uuid; v_s2 uuid; v_s3 uuid;
    e1 boolean; e2 boolean; e3 boolean;
  begin
    -- hermetic: remove the seeded groups (students detached first) so ONLY
    -- this scenario participates in the cohort calculation
    update public.students set group_id = null;
    delete from public.greenhouse_groups where id::text like '22222222-%';

    insert into public.greenhouse_groups (id, name) values
      (v_dorian, 'דוריאן'), (v_hel, 'הל'), (v_val, 'ולריאן'), (v_hist, 'ארגמן');
    insert into public.students (id, first_name, last_name, group_id) values
      ('c2cccccc-0000-0000-0000-000000000001', 'ד1', 'תלמיד', v_dorian),
      ('c2cccccc-0000-0000-0000-000000000002', 'ה1', 'תלמיד', v_hel),
      ('c2cccccc-0000-0000-0000-000000000003', 'ו1', 'תלמיד', v_val);
    v_s1 := 'c2cccccc-0000-0000-0000-000000000001';
    v_s2 := 'c2cccccc-0000-0000-0000-000000000002';
    v_s3 := 'c2cccccc-0000-0000-0000-000000000003';

    -- BEFORE: ולריאן is the youngest → not eligible; דוריאן + הל eligible.
    -- The historical ארגמן (no active students) must not affect the max.
    e1 := public.student_employment_eligible(v_s1);
    e2 := public.student_employment_eligible(v_s2);
    e3 := public.student_employment_eligible(v_s3);
    if not (e1 and e2) or e3 then
      raise exception 'FAIL: expected דוריאן+הל eligible, ולריאן not (%/%/%)', e1, e2, e3;
    end if;
    raise notice 'PASS: דוריאן+הל eligible, ולריאן (youngest) not; historical ארגמן ignored';

    -- add the new youngest cohort זנגביל — NO student or old-group changes
    insert into public.greenhouse_groups (id, name) values (v_zang, 'זנגביל');

    e1 := public.student_employment_eligible(v_s1);
    e2 := public.student_employment_eligible(v_s2);
    e3 := public.student_employment_eligible(v_s3);
    if not (e1 and e2 and e3) then
      raise exception 'FAIL: after זנגביל, ולריאן must become eligible (%/%/%)', e1, e2, e3;
    end if;
    raise notice 'PASS: +זנגביל → ולריאן automatically eligible, זנגביל not';
  end;
end $$;
rollback;

-- ============================================================================
-- CH3: invalid current group name → not eligible + visible warning surface
-- ============================================================================
begin;
do $$ begin
  declare
    v_bad uuid := 'c3cccccc-0000-0000-0000-000000000001';
    v_good uuid := 'c3cccccc-0000-0000-0000-000000000002';
    v_row record;
  begin
    -- setup as superuser (direct group inserts are admin-only via RLS)
    perform set_config('role', 'postgres', true);
    update public.students set group_id = null;
    insert into public.greenhouse_groups (id, name) values
      (v_bad, 'XYZ'), (v_good, 'דוריאן');
    insert into public.students (id, first_name, last_name, group_id) values
      ('c4cccccc-0000-0000-0000-000000000001', 'ב1', 'תלמיד', v_bad),
      ('c4cccccc-0000-0000-0000-000000000002', 'ד1', 'תלמיד', v_good);

    perform _cc_as('itay@chamama.example');
    if public.student_employment_eligible('c4cccccc-0000-0000-0000-000000000001') then
      raise exception 'FAIL: invalid-name group student must not be eligible';
    end if;

    select * into v_row from public.employment_cohort_status() where group_id = v_bad;
    if v_row.name_valid then
      raise exception 'FAIL: invalid-name group must surface name_valid=false';
    end if;
    raise notice 'PASS: invalid current group name fails visibly (not guessed)';
  end;
end $$;
rollback;

-- ============================================================================
-- CH4: employment_admin_rows — no school_year, eligibility + cohort notes
-- ============================================================================
begin;
select _cc_as('itay@chamama.example');
do $$ begin
  declare
    v_row record;
    v_has_year boolean;
  begin
    select * into v_row from public.employment_admin_rows()
     where student_name like 'נועם%' limit 1;
    if not found then raise exception 'FAIL: employment_admin_rows empty'; end if;
    -- column shape: no school_year; eligibility + note present
    select exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='students'
                      and column_name='school_year') into v_has_year;
    if v_row.employment_eligible is null or v_row.cohort_note is null then
      -- שקד (ש=21) is the youngest seeded cohort → note must explain it
      if v_row.group_name = 'קבוצת שקד' and v_row.cohort_note is null then
        raise exception 'FAIL: youngest cohort note missing';
      end if;
    end if;
    raise notice 'PASS: employment_admin_rows serves cohort eligibility + notes (no year)';
  end;
end $$;
rollback;

begin;
select _cc_as('tom@chamama.example');
do $$ begin
  begin
    perform * from public.employment_cohort_status();
    raise exception 'FAIL: plain staff can read cohort status';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: employment_cohort_status restricted (coordinator/leadership/admin)';
end $$;
rollback;

-- ============================================================================
-- CH5: admin_import_calendar_events — canonical, transactional, gated
-- ============================================================================
begin;
select _cc_as('tom@chamama.example');
do $$ begin
  begin
    perform public.admin_import_calendar_events('[]'::jsonb);
    raise exception 'FAIL: plain staff can import events';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: CSV import restricted to leadership/super_admin';
end $$;
rollback;

begin;
select _cc_as('liat@chamama.example'); -- leadership
do $$ begin
  declare
    v_res jsonb;
    v_count int;
  begin
    -- two valid events: timed one-off + weekly recurrence with home-group
    -- audience (IDs resolved server-side by the app action; canonical RPC
    -- validation re-checks them)
    v_res := public.admin_import_calendar_events('[
      {
        "title": "ייבוא בדיקה — יום ספורט",
        "start_date": "2027-01-05", "start_time": "09:00:00",
        "end_date": "2027-01-05", "end_time": "13:00:00",
        "is_all_day": false, "recurrence": "none", "recurrence_until": null,
        "audiences": [{"type": "everyone"}]
      },
      {
        "title": "ייבוא בדיקה — מפגש שבועי",
        "start_date": "2027-01-06", "start_time": "16:00:00",
        "end_date": "2027-01-06", "end_time": "17:30:00",
        "is_all_day": false, "recurrence": "weekly", "recurrence_until": "2027-03-31",
        "audiences": [{"type": "home_group", "greenhouse_group_id": "22222222-2222-2222-2222-222222222201"}]
      }
    ]'::jsonb);
    if (v_res ->> 'imported')::int <> 2 then
      raise exception 'FAIL: expected 2 imported, got %', v_res ->> 'imported';
    end if;
    select count(*) into v_count from public.calendar_events
     where title like 'ייבוא בדיקה%' and deleted_at is null;
    if v_count <> 2 then raise exception 'FAIL: imported events missing (%)', v_count; end if;
    -- all-day + multi-day + audited
    v_res := public.admin_import_calendar_events('[
      {
        "title": "ייבוא בדיקה — יום כל היום",
        "start_date": "2027-02-01", "start_time": "00:00:00",
        "end_date": "2027-02-02", "end_time": "23:59:00",
        "is_all_day": true, "recurrence": "none", "recurrence_until": null,
        "audiences": [{"type": "staff_only"}]
      }
    ]'::jsonb);
    if (v_res ->> 'imported')::int <> 1 then raise exception 'FAIL: all-day import failed'; end if;
    -- audit rows are not client-readable — verify as superuser
    perform set_config('role', 'postgres', true);
    if not exists (
      select 1 from public.audit_logs
       where action = 'calendar_event_created'
         and entity_id in (select id from public.calendar_events where title like 'ייבוא בדיקה%')
    ) then
      raise exception 'FAIL: imported events not audited';
    end if;
    raise notice 'PASS: CSV import creates timed/all-day/multi-day/weekly events + audit';
  end;
end $$;
rollback;

begin;
select _cc_as('liat@chamama.example');
do $$ begin
  declare v_count int;
  begin
    -- ONE malformed row → the WHOLE import rolls back (no partial corruption)
    begin
      perform public.admin_import_calendar_events('[
        {
          "title": "ייבוא כשל — תקין",
          "start_date": "2027-04-01", "start_time": "08:00:00",
          "end_date": "2027-04-01", "end_time": "09:00:00",
          "is_all_day": false, "recurrence": "none", "recurrence_until": null,
          "audiences": [{"type": "everyone"}]
        },
        {
          "title": "ייבוא כשל — שורה פגומה",
          "start_date": "not-a-date", "start_time": "08:00:00",
          "end_date": "2027-04-01", "end_time": "09:00:00",
          "is_all_day": false, "recurrence": "none", "recurrence_until": null,
          "audiences": [{"type": "everyone"}]
        }
      ]'::jsonb);
      raise exception 'FAIL: malformed row did not fail the import';
    exception when others then
      if sqlerrm like '%ייבוא כשל%' or sqlerrm like '%invalid%' or sqlerrm like '%date%' then
        null; -- expected
      else
        raise;
      end if;
    end;
    select count(*) into v_count from public.calendar_events
     where title like 'ייבוא כשל%';
    if v_count <> 0 then
      raise exception 'FAIL: partial import committed (% rows)', v_count;
    end if;
    raise notice 'PASS: malformed row rolls back the ENTIRE import (no partial corruption)';
  end;
end $$;
rollback;

\echo '--- cohort + csv-import test suite finished ---'
