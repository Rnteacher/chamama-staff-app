-- ============================================================================
-- Employment tests (phase 3) — run against a database with all migrations
-- applied + seed:
--   supabase db reset && psql -f supabase/tests/employment_tests.sql
-- (Windows note: run the FILE via psql -f, not piped stdin, so Hebrew
--  literals keep their UTF-8 encoding.)
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- NOTE: psql :vars are NOT substituted inside dollar-quoted blocks, so the
-- seed UUIDs are written as literals.
-- ============================================================================

\echo '--- starting employment test suite ---'

-- claim helper (claim auth identity so current_staff_id() resolves)
create or replace function pg_temp.claim_as(p_email text, p_sub text)
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  update public.profiles set auth_user_id = p_sub::uuid
   where email = p_email and auth_user_id is null;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;

-- seed UUID constants
-- noam      = 44444444-4444-4444-4444-444444444401  (ג, active placement)
-- tamar     = 44444444-4444-4444-4444-444444444405  (ב, exactly 200h)
-- gili      = 44444444-4444-4444-4444-444444444409  (ד, above 200h)
-- opaz      = 44444444-4444-4444-4444-444444444402  (ג, no placement)
-- aleph     = 44444444-4444-4444-4444-44444444440d  (א, not eligible)
-- noam_place= 88888888-8888-8888-8888-888888888802

-- ============================================================================
-- E0: role + schema sanity
-- ============================================================================
do $$ begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'app_role' and e.enumlabel = 'employment_coordinator'
  ) then
    raise exception 'FAIL: employment_coordinator role missing from app_role';
  end if;
  if (select count(*) from information_schema.tables
      where table_schema='public' and table_name in
      ('student_employment_placements','student_employment_weekly_slots',
       'student_employment_exceptions','student_employment_work_logs')) <> 4 then
    raise exception 'FAIL: employment schema incomplete';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='students'
       and column_name='school_year'
  ) then
    raise exception 'FAIL: students.school_year missing';
  end if;
  raise notice 'PASS: role + schema present';
end $$;

-- ============================================================================
-- E1: resolver — weekly work day / non-work day
-- ============================================================================
do $$ declare
  v_next_tuesday date := current_date + ((2 - extract(dow from current_date)::int + 7) % 7);
  v_next_friday  date := current_date + ((5 - extract(dow from current_date)::int + 7) % 7);
  r record;
begin
  -- Tuesday = weekly work day 08:30–15:00 (seed)
  select * into r from public.is_student_expected_at_work(
    '44444444-4444-4444-4444-444444444401', v_next_tuesday);
  if not r.expected or r.source <> 'weekly'
     or r.start_time <> '08:30'::time or r.end_time <> '15:00'::time
     or r.workplace_name is null then
    raise exception 'FAIL: weekly Tuesday not resolved correctly: %', r;
  end if;

  -- Friday = not a work day
  select * into r from public.is_student_expected_at_work(
    '44444444-4444-4444-4444-444444444401', v_next_friday);
  if r.expected then
    raise exception 'FAIL: non-work day resolved as expected';
  end if;

  -- year-א student: not employment-eligible
  if public.student_employment_eligible('44444444-4444-4444-4444-44444444440d') then
    raise exception 'FAIL: year-א student marked eligible';
  end if;
  raise notice 'PASS: weekly resolver + non-work day + eligibility';
end $$;

-- ============================================================================
-- E2: exceptions — add / cancel / modify govern the day
-- ============================================================================
begin;
select pg_temp.claim_as('itay@chamama.example', '11111111-1111-1111-1111-111111111105');
do $$ declare
  v_tue date := current_date + ((2 - extract(dow from current_date)::int + 7) % 7);
  v_sun date := current_date + ((0 - extract(dow from current_date)::int + 7) % 7);
  r record;
  v_eid uuid;
begin
  -- cancel: NOT working on the normal Tuesday
  v_eid := public.admin_upsert_employment_exception(
    null, '88888888-8888-8888-8888-888888888802', v_tue, 'cancel', null, null, null);
  select * into r from public.is_student_expected_at_work(
    '44444444-4444-4444-4444-444444444401', v_tue);
  if r.expected then
    raise exception 'FAIL: cancel exception did not cancel the work day';
  end if;

  -- delete the cancel → the weekly plan governs again
  perform public.admin_delete_employment_exception(v_eid);
  select * into r from public.is_student_expected_at_work(
    '44444444-4444-4444-4444-444444444401', v_tue);
  if not r.expected or r.source <> 'weekly' or r.start_time <> '08:30'::time then
    raise exception 'FAIL: cancel deletion did not restore weekly plan: %', r;
  end if;

  -- modify: different hours on Tuesday (replaces the weekly window)
  perform public.admin_upsert_employment_exception(
    null, '88888888-8888-8888-8888-888888888802', v_tue, 'modify', '12:00', '18:00', null);
  select * into r from public.is_student_expected_at_work(
    '44444444-4444-4444-4444-444444444401', v_tue);
  if not r.expected or r.source <> 'override'
     or r.start_time <> '12:00'::time or r.end_time <> '18:00'::time then
    raise exception 'FAIL: modify exception did not replace the weekly hours: %', r;
  end if;

  -- add: works on a Sunday despite not a weekly work day
  v_eid := public.admin_upsert_employment_exception(
    null, '88888888-8888-8888-8888-888888888802', v_sun, 'add', '10:00', '14:00', null);
  select * into r from public.is_student_expected_at_work(
    '44444444-4444-4444-4444-444444444401', v_sun);
  if not r.expected or r.source <> 'override'
     or r.start_time <> '10:00'::time or r.end_time <> '14:00'::time then
    raise exception 'FAIL: add exception did not add the work day: %', r;
  end if;

  raise notice 'PASS: add / cancel / modify exceptions + delete restores plan';
end $$;
rollback;

-- ============================================================================
-- E3: placements — create, auto-end previous (history), validation
-- ============================================================================
begin;
select pg_temp.claim_as('itay@chamama.example', '11111111-1111-1111-1111-111111111105');
do $$ declare
  v jsonb; v_id uuid; v_active int;
begin
  -- create a new placement for the student who ALREADY has an active one
  select public.admin_upsert_employment_placement(
    null, '44444444-4444-4444-4444-444444444401', 'מאפיית החממה', null, null,
    current_date + 30, null, null,
    '[{"weekday":4,"start_time":"08:00","end_time":"13:00"}]'::jsonb) into v;
  v_id := (v ->> 'id')::uuid;

  -- previous active placement auto-ended; history preserved
  select count(*) into v_active from public.student_employment_placements
   where student_id = '44444444-4444-4444-4444-444444444401' and is_active;
  if v_active <> 1 then
    raise exception 'FAIL: more than one active placement after re-placement';
  end if;
  if (select count(*) from public.student_employment_placements
      where student_id = '44444444-4444-4444-4444-444444444401') <> 3 then
    raise exception 'FAIL: placement history destroyed';
  end if;
  if (select count(*) from public.student_employment_weekly_slots
      where placement_id = v_id) <> 1 then
    raise exception 'FAIL: slots not saved';
  end if;

  -- ineligible student rejected
  begin
    perform public.admin_upsert_employment_placement(
      null, '44444444-4444-4444-4444-44444444440d', 'לא רלוונטי', null, null,
      current_date, null, null, '[]'::jsonb);
    raise exception 'FAIL: ineligible student placed';
  exception when check_violation then null; end;

  -- slot end <= start rejected
  begin
    perform public.admin_upsert_employment_placement(
      null, '44444444-4444-4444-4444-444444444402', 'מקום כלשהו', null, null,
      current_date, null, null,
      '[{"weekday":1,"start_time":"15:00","end_time":"08:00"}]'::jsonb);
    raise exception 'FAIL: invalid slot accepted';
  exception when check_violation then null; end;

  raise notice 'PASS: placement create, auto-end previous, history kept, validation';
end $$;
rollback;

-- ============================================================================
-- E4: work logs — derived duration, edit, delete, invalid rejected, totals
-- ============================================================================
begin;
select pg_temp.claim_as('itay@chamama.example', '11111111-1111-1111-1111-111111111105');
do $$ declare
  v jsonb; v_id uuid; v_before int; v_after int;
begin
  select public.student_employment_minutes('44444444-4444-4444-4444-444444444401') into v_before;

  -- start+end → derived duration (2.5h = 150min)
  select public.admin_upsert_work_log(
    null, '88888888-8888-8888-8888-888888888802', current_date - 1, '08:30', '11:00', null, null) into v;
  v_id := (v ->> 'id')::uuid;
  if (v ->> 'minutes')::int <> 150 then
    raise exception 'FAIL: derived duration wrong: %', v ->> 'minutes';
  end if;
  if (select duration_minutes from public.student_employment_work_logs where id = v_id) <> 150 then
    raise exception 'FAIL: duration not persisted';
  end if;

  -- contradictory explicit duration rejected
  begin
    perform public.admin_upsert_work_log(
      null, '88888888-8888-8888-8888-888888888802', current_date - 2, '08:00', '10:00', 999, null);
    raise exception 'FAIL: contradictory duration accepted';
  exception when check_violation then null; end;

  -- invalid: end <= start
  begin
    perform public.admin_upsert_work_log(
      null, '88888888-8888-8888-8888-888888888802', current_date - 2, '10:00', '08:00', null, null);
    raise exception 'FAIL: end<=start log accepted';
  exception when check_violation then null; end;

  -- invalid: > 12h per day
  begin
    perform public.admin_upsert_work_log(
      null, '88888888-8888-8888-8888-888888888802', current_date - 2, '08:00', '23:00', null, null);
    raise exception 'FAIL: >12h log accepted';
  exception when check_violation then null; end;

  -- duplicate same period rejected
  begin
    perform public.admin_upsert_work_log(
      null, '88888888-8888-8888-8888-888888888802', current_date - 1, '08:30', '11:00', null, null);
    raise exception 'FAIL: duplicate log accepted';
  exception when unique_violation then null; end;

  -- edit changes total
  perform public.admin_upsert_work_log(
    v_id, '88888888-8888-8888-8888-888888888802', current_date - 1, '08:30', '12:30', null, null);
  select public.student_employment_minutes('44444444-4444-4444-4444-444444444401') into v_after;
  if v_after <> v_before + 240 then
    raise exception 'FAIL: totals did not recompute after edit (% -> %)', v_before, v_after;
  end if;

  -- delete restores total
  perform public.admin_delete_work_log(v_id);
  select public.student_employment_minutes('44444444-4444-4444-4444-444444444401') into v_after;
  if v_after <> v_before then
    raise exception 'FAIL: delete did not restore total';
  end if;

  raise notice 'PASS: work logs derive/edit/delete/totals + validation';
end $$;
rollback;

-- ============================================================================
-- E5: 200-hour progress buckets (0 / partial / exactly 200 / above 200)
-- ============================================================================
do $$ declare
  v_noam int; v_tamar int; v_gili int; v_opaz int;
begin
  select public.student_employment_minutes('44444444-4444-4444-4444-444444444401') into v_noam;
  select public.student_employment_minutes('44444444-4444-4444-4444-444444444405') into v_tamar;
  select public.student_employment_minutes('44444444-4444-4444-4444-444444444409') into v_gili;
  select public.student_employment_minutes('44444444-4444-4444-4444-444444444402') into v_opaz;

  if v_noam <= 0 or v_noam >= 12000 then
    raise exception 'FAIL: partial bucket wrong: %', v_noam;
  end if;
  if v_tamar <> 12000 then
    raise exception 'FAIL: exactly-200 bucket wrong: %', v_tamar;
  end if;
  if v_gili <= 12000 then
    raise exception 'FAIL: above-200 bucket wrong: %', v_gili;
  end if;
  if v_opaz <> 0 then
    raise exception 'FAIL: zero bucket wrong: %', v_opaz;
  end if;

  -- progress filter (5th arg = p_progress) in the management rows RPC
  if (select count(*) from public.employment_admin_rows(null, null, null, null, 'at')
      where student_id = '44444444-4444-4444-4444-444444444405') <> 1 then
    raise exception 'FAIL: at-200 filter wrong';
  end if;
  if (select count(*) from public.employment_admin_rows(null, null, null, null, 'above')
      where student_id = '44444444-4444-4444-4444-444444444409') <> 1 then
    raise exception 'FAIL: above-200 filter wrong';
  end if;
  if (select count(*) from public.employment_admin_rows(null, null, null, 'none', null)
      where student_id = '44444444-4444-4444-4444-444444444402') <> 1 then
    raise exception 'FAIL: no-placement filter wrong';
  end if;
  if exists (
    select 1 from public.employment_admin_rows(null, null, null, null, null)
     where school_year = 1
  ) then
    raise exception 'FAIL: year-א student present in employment rows';
  end if;
  -- NULL-year students are intentionally SURFACED (see E12), so only year-א
  -- and explicit non-2..4 years are forbidden here.
  raise notice 'PASS: 200h progress buckets (0 / partial / exact / above) + filters';
end $$;

-- ============================================================================
-- E6: unified student schedule — employment present, ordering kept
-- ============================================================================
do $$ declare
  v_tue date := current_date + ((2 - extract(dow from current_date)::int + 7) % 7);
  v_employment int; v_other int; v_bad_order int;
begin
  select count(*) into v_employment
    from public.student_day_schedule(
           '44444444-4444-4444-4444-444444444401', v_tue)
   where source_type = 'employment'
     and title like 'עבודה — %'
     and (start_at at time zone 'Asia/Jerusalem')::time = '08:30'::time
     and (end_at at time zone 'Asia/Jerusalem')::time = '15:00'::time;
  if v_employment <> 1 then
    raise exception 'FAIL: employment missing from student schedule (got %)', v_employment;
  end if;

  -- all items chronologically ordered
  select count(*) into v_bad_order from (
    select start_at, lag(start_at) over (order by start_at) prev
      from public.student_day_schedule('44444444-4444-4444-4444-444444444401', v_tue)
  ) t where start_at < prev;
  if v_bad_order > 0 then
    raise exception 'FAIL: student schedule not chronologically ordered';
  end if;

  -- employment is an ADDITION: today's calendar items still resolve
  select count(*) into v_other
    from public.student_day_schedule('44444444-4444-4444-4444-444444444401', current_date)
   where source_type = 'calendar_event';
  if v_other < 1 then
    raise exception 'FAIL: calendar items disappeared from schedule';
  end if;

  raise notice 'PASS: employment in unified schedule + ordering kept';
end $$;

-- ============================================================================
-- E7: conflict check — employment warns, touching does not
-- ============================================================================
begin;
select pg_temp.claim_as('michal@chamama.example', '11111111-1111-1111-1111-111111111102');
do $$ declare
  v_tue date := current_date + ((2 - extract(dow from current_date)::int + 7) % 7);
  v_rows int;
begin
  -- 10:00 meeting inside Tue 08:30–15:00 work → warns with employment source
  if not exists (
    select 1 from public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[v_tue], '10:00', 60)
     where source_type = 'employment'
       and title like 'עבודה — %'
       and description like '%בעבודה בבית קפה החממה%'
  ) then
    raise exception 'FAIL: employment conflict missing';
  end if;

  -- touching boundary: 15:00–16:00 meeting vs work ending 15:00 → NO conflict
  select count(*) into v_rows
    from public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[v_tue], '15:00', 60)
   where source_type = 'employment';
  if v_rows <> 0 then
    raise exception 'FAIL: touching boundary warned';
  end if;

  -- other conflict sources still function (Monday meeting+LG for נועם)
  v_rows := (select count(*) from public.check_student_meeting_conflicts(
    '44444444-4444-4444-4444-444444444401',
    array[current_date + ((1 - extract(dow from current_date)::int + 7) % 7)], '16:00', 60));
  if v_rows < 2 then
    raise exception 'FAIL: LG/meeting conflicts broke (% rows)', v_rows;
  end if;

  raise notice 'PASS: employment conflicts (warn / touching OK / others intact)';
end $$;
rollback;

-- ============================================================================
-- E8: permissions — coordinator ok, leadership ok, super_admin ok, staff no
-- ============================================================================
begin;
select pg_temp.claim_as('itay@chamama.example', '11111111-1111-1111-1111-111111111105');
do $$ begin
  perform public.admin_upsert_work_log(
    null, '88888888-8888-8888-8888-888888888802', current_date - 3, '09:00', '13:00', null, null);
  raise notice 'PASS: employment_coordinator can mutate';
end $$;
rollback;

begin;
select pg_temp.claim_as('liat@chamama.example', '11111111-1111-1111-1111-111111111109');
do $$ begin
  perform public.admin_upsert_work_log(
    null, '88888888-8888-8888-8888-888888888802', current_date - 3, '09:00', '13:00', null, null);
  raise notice 'PASS: leadership can mutate';
end $$;
rollback;

begin;
select pg_temp.claim_as('ronen@chamama.example', '11111111-1111-1111-1111-111111111101');
do $$ begin
  perform public.admin_upsert_work_log(
    null, '88888888-8888-8888-8888-888888888802', current_date - 3, '09:00', '13:00', null, null);
  raise notice 'PASS: super_admin can mutate';
end $$;
rollback;

begin;
select pg_temp.claim_as('tom@chamama.example', '11111111-1111-1111-1111-11111111110a');
do $$ begin
  begin
    perform public.admin_upsert_work_log(
      null, '88888888-8888-8888-8888-888888888802', current_date - 3, '09:00', '13:00', null, null);
    raise exception 'FAIL: plain staff mutated employment';
  exception when insufficient_privilege then null; end;
  begin
    perform public.admin_upsert_employment_exception(
      null, '88888888-8888-8888-8888-888888888802', current_date, 'cancel', null, null, null);
    raise exception 'FAIL: plain staff mutated employment schedule';
  exception when insufficient_privilege then null; end;
  begin
    perform public.admin_upsert_employment_placement(
      null, '44444444-4444-4444-4444-444444444402', 'אסור', null, null,
      current_date, null, null, '[]'::jsonb);
    raise exception 'FAIL: plain staff created placement';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: ordinary staff blocked from all employment mutations';
end $$;
rollback;

-- ============================================================================
-- E9: RLS — staff read, anon zero, direct writes blocked
-- ============================================================================
begin;
select pg_temp.claim_as('tom@chamama.example', '11111111-1111-1111-1111-11111111110a');
do $$ begin
  if (select count(*) from public.student_employment_placements) < 3 then
    raise exception 'FAIL: staff cannot read placements';
  end if;
  begin
    insert into public.student_employment_work_logs
      (placement_id, student_id, work_date, duration_minutes, entered_by_staff_id)
    values ('88888888-8888-8888-8888-888888888802', '44444444-4444-4444-4444-444444444401',
            current_date, 60, '11111111-1111-1111-1111-11111111110a');
    raise exception 'FAIL: direct log insert succeeded';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: staff reads placements; direct insert blocked';
end $$;
rollback;

begin;
select set_config('role', 'anon', true);
do $$ begin
  if (select count(*) from public.student_employment_placements) <> 0 then
    raise exception 'FAIL: anon reads placements';
  end if;
  begin
    perform public.student_employment_overview('44444444-4444-4444-4444-444444444401');
    raise exception 'FAIL: anon called employment RPC';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: anon has zero employment access';
end $$;
rollback;

-- ============================================================================
-- E10: audit actions written
-- ============================================================================
begin;
select pg_temp.claim_as('itay@chamama.example', '11111111-1111-1111-1111-111111111105');
do $$ declare v jsonb; v_id uuid;
begin
  select public.admin_upsert_work_log(
    null, '88888888-8888-8888-8888-888888888802', current_date - 3, '09:00', '13:00', null, null) into v;
  v_id := (v ->> 'id')::uuid;
  perform public.admin_upsert_work_log(
    v_id, '88888888-8888-8888-8888-888888888802', current_date - 3, '09:00', '14:00', null, null);
  perform public.admin_delete_work_log(v_id);
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.audit_logs where action = 'employment_work_log_created') < 1
     or (select count(*) from public.audit_logs where action = 'employment_work_log_updated') < 1
     or (select count(*) from public.audit_logs where action = 'employment_work_log_deleted') < 1 then
    raise exception 'FAIL: work-log audit missing';
  end if;
  raise notice 'PASS: work-log create/update/delete audited';
end $$;
rollback;

-- placement + schedule audit (seed writes placement_created for its rows)
do $$ begin
  if (select count(*) from public.audit_logs where action = 'employment_placement_created') < 4 then
    raise exception 'FAIL: placement audit missing';
  end if;
  raise notice 'PASS: placement audit present';
end $$;

-- ============================================================================
-- E11: DST — a 08:30 Jerusalem work slot stays 08:30 across IDT→IST
-- (Israel switches on 2026-10-25: 08:30 IDT = 05:30Z, 08:30 IST = 06:30Z)
-- ============================================================================
begin;
select pg_temp.claim_as('itay@chamama.example', '11111111-1111-1111-1111-111111111105');
do $$ declare
  v jsonb; v_pid uuid; r record; v_bad int := 0;
begin
  -- placement whose weekly slot spans the DST change
  select public.admin_upsert_employment_placement(
    null, '44444444-4444-4444-4444-444444444402', 'dst-probe', null, null,
    date '2026-10-01', null, null,
    '[{"weekday":2,"start_time":"08:30","end_time":"15:00"}]'::jsonb) into v;
  v_pid := (v ->> 'id')::uuid;

  -- compose 08:30 on both sides of the boundary directly
  if public.compose_jerusalem(date '2026-10-20', '08:30') <> '2026-10-20T05:30:00Z'::timestamptz then
    raise exception 'FAIL: IDT composition wrong';
  end if;
  if public.compose_jerusalem(date '2026-11-03', '08:30') <> '2026-11-03T06:30:00Z'::timestamptz then
    raise exception 'FAIL: IST composition wrong (wall time shifted)';
  end if;

  -- and the resolver window is wall-clock by construction (times, not instants)
  select * into r from public.is_student_expected_at_work(
    '44444444-4444-4444-4444-444444444402', date '2026-10-20');
  if not r.expected or r.start_time <> '08:30'::time then
    raise exception 'FAIL: DST probe resolver wrong';
  end if;

  raise notice 'PASS: DST preserves 08:30 Jerusalem wall time (05:30Z IDT / 06:30Z IST)';
end $$;
rollback;

-- ============================================================================
-- E12: missing-year surfacing + explicit year assignment (pre-deploy check)
--   - NULL-year students are RETURNED by employment_admin_rows (never hidden)
--   - year-א students remain excluded
--   - p_year = 0 filters "year not set"
--   - leadership/super_admin can set/clear the year (audited); coordinator
--     and plain staff cannot
-- ============================================================================
do $$ declare
  v_cnt int;
begin
  -- תהל מוסקל (40e) is seeded with school_year NULL: must appear, flagged by NULL year
  select count(*) into v_cnt from public.employment_admin_rows(null, null, null, null, null)
   where student_id = '44444444-4444-4444-4444-44444444440e' and school_year is null;
  if v_cnt <> 1 then
    raise exception 'FAIL: NULL-year student hidden from employment rows';
  end if;

  -- year-א student (40d) remains excluded
  if exists (
    select 1 from public.employment_admin_rows(null, null, null, null, null)
     where student_id = '44444444-4444-4444-4444-44444444440d'
  ) then
    raise exception 'FAIL: year-א student present in employment rows';
  end if;

  -- p_year = 0 → exactly the not-set students
  select count(*) into v_cnt from public.employment_admin_rows(null, 0::smallint, null, null, null)
   where school_year is not null;
  if v_cnt <> 0 then
    raise exception 'FAIL: p_year=0 filter leaks years';
  end if;
  if (select count(*) from public.employment_admin_rows(null, 0::smallint, null, null, null)
      where student_id = '44444444-4444-4444-4444-44444444440e') <> 1 then
    raise exception 'FAIL: p_year=0 filter misses the NULL-year student';
  end if;

  -- NULL-year student is NOT eligible for placement until the year is set
  if public.student_employment_eligible('44444444-4444-4444-4444-44444444440e') then
    raise exception 'FAIL: NULL-year student treated as eligible';
  end if;

  raise notice 'PASS: NULL-year students surfaced (never hidden), year-א excluded, not-set filter';
end $$;

begin;
select pg_temp.claim_as('liat@chamama.example', '11111111-1111-1111-1111-111111111109');
do $$ begin
  -- leadership sets the year → student becomes eligible
  perform public.admin_set_student_school_year(
    '44444444-4444-4444-4444-44444444440e', 2::smallint);
  if not public.student_employment_eligible('44444444-4444-4444-4444-44444444440e') then
    raise exception 'FAIL: year set but student still not eligible';
  end if;
  -- clear again → back to not-eligible
  perform public.admin_set_student_school_year(
    '44444444-4444-4444-4444-44444444440e', null);
  if public.student_employment_eligible('44444444-4444-4444-4444-44444444440e') then
    raise exception 'FAIL: cleared year still eligible';
  end if;
  raise notice 'PASS: leadership sets and clears the school year';
end $$;
rollback;

begin;
select pg_temp.claim_as('itay@chamama.example', '11111111-1111-1111-1111-111111111105');
do $$ begin
  begin
    perform public.admin_set_student_school_year(
      '44444444-4444-4444-4444-44444444440e', 2::smallint);
    raise exception 'FAIL: coordinator set a school year';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: coordinator cannot set school years';
end $$;
rollback;

begin;
select pg_temp.claim_as('tom@chamama.example', '11111111-1111-1111-1111-11111111110a');
do $$ begin
  begin
    perform public.admin_set_student_school_year(
      '44444444-4444-4444-4444-44444444440e', 2::smallint);
    raise exception 'FAIL: plain staff set a school year';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: plain staff cannot set school years';
end $$;
rollback;

begin;
select pg_temp.claim_as('ronen@chamama.example', '11111111-1111-1111-1111-111111111101');
do $$ begin
  begin
    perform public.admin_set_student_school_year(
      '44444444-4444-4444-4444-44444444440e', 5::smallint);
    raise exception 'FAIL: invalid year accepted';
  exception when check_violation then null;
  when others then
    if sqlerrm not like '%שנת לימודים לא תקינה%' and sqlerrm not like '%check%' then
      raise exception 'FAIL: unexpected error: %', sqlerrm;
    end if;
  end;
  raise notice 'PASS: invalid year rejected';
end $$;
rollback;

-- year assignment audited
begin;
select pg_temp.claim_as('liat@chamama.example', '11111111-1111-1111-1111-111111111109');
do $$ begin
  perform public.admin_set_student_school_year('44444444-4444-4444-4444-44444444440e', 3::smallint);
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if not exists (
    select 1 from public.audit_logs
     where action = 'student_school_year_set'
       and entity_id = '44444444-4444-4444-4444-44444444440e'
       and metadata ->> 'school_year' = '3'
  ) then
    raise exception 'FAIL: school-year assignment not audited';
  end if;
  raise notice 'PASS: school-year assignment audited';
end $$;
rollback;

\echo '--- employment test suite finished (no FAIL above = clean) ---'
