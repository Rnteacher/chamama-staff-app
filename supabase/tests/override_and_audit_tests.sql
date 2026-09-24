-- ============================================================================
-- Employment tri-state override + audit pagination tests (migration
-- 20260923000002).
--   supabase db reset && psql -f supabase/tests/override_and_audit_tests.sql
-- (vanilla Postgres: apply supabase/tests/local-postgres-stub.sql first)
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
--
-- Seeded cohorts: זית=ז(7) שקד=ש(21)=YOUNGEST רימון=ר(20) דקל=ד(4)
--   noam  = 44444444-4444-4444-4444-444444444401  (זית — older → eligible)
--   leo   = 44444444-4444-4444-4444-444444444405  (שקד — youngest → NOT)
-- ============================================================================

\set ronen   '11111111-1111-1111-1111-111111111101' -- super_admin
\set amit    '11111111-1111-1111-1111-111111111108' -- project_coordinator
\set tom     '11111111-1111-1111-1111-11111111110a' -- plain staff
\set itay    '11111111-1111-1111-1111-111111111105' -- employment_coordinator

\echo '--- starting override + audit test suite ---'

create or replace function _oa_as(p_email text) returns void
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

create or replace function _oa_reset() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ============================================================================
-- OV1: schema — tri-state storage, RLS on, no client policies
-- ============================================================================
do $$ begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema='public' and table_name='student_employment_overrides'
  ) then
    raise exception 'FAIL: student_employment_overrides table missing';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relname='student_employment_overrides' and c.relrowsecurity
  ) then
    raise exception 'FAIL: overrides table must have RLS enabled';
  end if;
  -- check constraint enforces the two explicit states (missing row = automatic)
  begin
    perform set_config('role', 'postgres', true);
    insert into public.student_employment_overrides (student_id, override)
    values ('44444444-4444-4444-4444-444444444401', 'maybe');
    raise exception 'FAIL: invalid override value accepted';
  exception when check_violation then null; end;
  perform _oa_reset();
  raise notice 'PASS: overrides table present, RLS on, tri-state check enforced';
end $$;

-- ============================================================================
-- OV2: effective eligibility (000008): older cohorts ALWAYS eligible (a
--      legacy force-ineligible row is ignored); youngest only when added
-- ============================================================================
begin;
do $$ begin
  perform set_config('role', 'postgres', true);
  -- automatic (no row): cohort rule — leo (שקד, youngest) NOT eligible
  if public.student_employment_eligible('44444444-4444-4444-4444-444444444405') then
    raise exception 'FAIL: youngest cohort must be auto-ineligible';
  end if;
  if not public.student_employment_eligible('44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: older cohort (זית) must be auto-eligible';
  end if;

  -- force eligible the youngest → eligible
  insert into public.student_employment_overrides (student_id, override)
  values ('44444444-4444-4444-4444-444444444405', 'eligible');
  if not public.student_employment_eligible('44444444-4444-4444-4444-444444444405') then
    raise exception 'FAIL: forced-eligible youngest must be eligible';
  end if;

  -- a LEGACY force-ineligible row on an older-cohort student is ignored
  insert into public.student_employment_overrides (student_id, override)
  values ('44444444-4444-4444-4444-444444444401', 'ineligible');
  if not public.student_employment_eligible('44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: legacy force-ineligible must not make an older student ineligible';
  end if;
  -- ...and on a youngest-cohort student it equals the default (not eligible)
  insert into public.student_employment_overrides (student_id, override)
  values ('44444444-4444-4444-4444-444444444406', 'ineligible');
  if public.student_employment_eligible('44444444-4444-4444-4444-444444444406') then
    raise exception 'FAIL: legacy force-ineligible youngest must stay not eligible';
  end if;

  -- reset to automatic → cohort behavior restored
  delete from public.student_employment_overrides
   where student_id in ('44444444-4444-4444-4444-444444444401',
                        '44444444-4444-4444-4444-444444444405',
                        '44444444-4444-4444-4444-444444444406');
  if public.student_employment_eligible('44444444-4444-4444-4444-444444444405') then
    raise exception 'FAIL: after reset, youngest must be auto-ineligible again';
  end if;
  if not public.student_employment_eligible('44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: after reset, older cohort must be eligible again';
  end if;
  raise notice 'PASS: youngest only when added; older always eligible (legacy deny ignored); reset restores default';
end $$;
rollback;

-- ============================================================================
-- OV3: admin_set_employment_override — authorization + audit
-- ============================================================================
begin;
select _oa_as('tom@chamama.example'); -- plain staff
do $$ begin
  begin
    perform public.admin_set_employment_override(
      '44444444-4444-4444-4444-444444444405', 'eligible');
    raise exception 'FAIL: plain staff can set an employment override';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: override mutation restricted to employment managers';
end $$;
rollback;

begin;
select _oa_as('itay@chamama.example'); -- employment_coordinator
do $$ begin
  declare
    v_noam  uuid := '44444444-4444-4444-4444-444444444401';
    v_count int;
  begin
    -- force-ineligible is no longer a manual decision: refused, nothing written
    begin
      perform public.admin_set_employment_override(v_noam, 'ineligible');
      raise exception 'FAIL: force-ineligible accepted';
    exception when invalid_parameter_value then null; end;
    perform public.admin_set_employment_override(v_noam, 'eligible');
    perform public.admin_set_employment_override(v_noam, 'eligible');
    perform public.admin_set_employment_override(v_noam, 'automatic');
    -- exactly one audit per decision, with prev→next metadata
    perform set_config('role', 'postgres', true);
    select count(*) into v_count from public.audit_logs
     where action in ('employment_override_set','employment_override_changed','employment_override_reset')
       and entity_id = v_noam;
    if v_count <> 3 then
      raise exception 'FAIL: expected 3 override audit rows, got %', v_count;
    end if;
    if not exists (
      select 1 from public.audit_logs
       where action = 'employment_override_changed' and entity_id = v_noam
         and metadata->>'from' = 'eligible' and metadata->>'to' = 'eligible'
    ) then
      raise exception 'FAIL: override change audit lacks prev→next metadata';
    end if;
    -- 'automatic' cleared the row (tri-state: automatic ≠ eligible)
    if exists (select 1 from public.student_employment_overrides where student_id = v_noam) then
      raise exception 'FAIL: reset to automatic must remove the override row';
    end if;
    raise notice 'PASS: employment coordinator adds/re-adds/resets (audited); force-ineligible refused';
  end;
end $$;
rollback;

-- ============================================================================
-- OV4: employment_admin_rows hides auto-ineligible, honors overrides
-- ============================================================================
begin;
select _oa_as('itay@chamama.example');
do $$ begin
  declare v_count int;
  begin
    -- youngest cohort (שקד: ליאו/שחר/רותם/אורי) is auto-ineligible → hidden
    select count(*) into v_count from public.employment_admin_rows()
     where student_name in ('ליאו הלוי','שחר ויסמן','רותם זוהר','אורי חדד');
    if v_count <> 0 then
      raise exception 'FAIL: auto-ineligible youngest cohort leaked into admin list (%)', v_count;
    end if;
    -- older cohorts present
    if not exists (select 1 from public.employment_admin_rows() where student_name like 'נועם%') then
      raise exception 'FAIL: eligible older-cohort student missing';
    end if;

    -- force-eligible the youngest → appears
    perform public.admin_set_employment_override(
      '44444444-4444-4444-4444-444444444405', 'eligible');
    if not exists (
      select 1 from public.employment_admin_rows()
       where student_name = 'ליאו הלוי'
    ) then
      raise exception 'FAIL: forced-eligible youngest must appear in the admin list';
    end if;

    -- a LEGACY force-ineligible row on an older student → still listed
    perform set_config('role', 'postgres', true);
    insert into public.student_employment_overrides (student_id, override)
    values ('44444444-4444-4444-4444-444444444401', 'ineligible');
    perform _oa_as('itay@chamama.example');
    if not exists (select 1 from public.employment_admin_rows() where student_name like 'נועם%') then
      raise exception 'FAIL: legacy force-ineligible older student must stay in the admin list';
    end if;
    raise notice 'PASS: employment_admin_rows lists only effectively-eligible students';
  end;
end $$;
rollback;

-- ============================================================================
-- OV5: placement creation follows the canonical rule: youngest default is
--      blocked; an older student with a legacy force-ineligible row is NOT
-- ============================================================================
begin;
select _oa_as('itay@chamama.example');
do $$ begin
  declare
    v_omer  uuid := '44444444-4444-4444-4444-444444444403'; -- older, no placement
    v_shahar uuid := '44444444-4444-4444-4444-444444444406'; -- youngest, default
  begin
    perform set_config('role', 'postgres', true);
    insert into public.student_employment_overrides (student_id, override)
    values (v_omer, 'ineligible');
    perform _oa_as('itay@chamama.example');
    perform public.admin_upsert_employment_placement(
      null, v_omer, 'מקום בדיקה', null, null,
      current_date, null, null, '[]'::jsonb);
    perform set_config('role', 'postgres', true);
    if not exists (select 1 from public.student_employment_placements where student_id = v_omer) then
      raise exception 'FAIL: older student with legacy force-ineligible could not be placed';
    end if;
    perform _oa_as('itay@chamama.example');
    begin
      perform public.admin_upsert_employment_placement(
        null, v_shahar, 'מקום בדיקה', null, null,
        current_date, null, null, '[]'::jsonb);
      raise exception 'FAIL: placement created for a youngest-cohort (not added) student';
    exception when others then
      if sqlerrm like '%לשבץ%' or sqlerrm like '%eligible%' or sqlerrm like '%Not authorized%' then
        null; -- expected: the canonical rule rejected the placement
      else
        raise;
      end if;
    end;
    raise notice 'PASS: placement: legacy deny ignored for older; youngest default still blocked';
  end;
end $$;
rollback;

-- ============================================================================
-- AU1: audit pagination — authorization (an unauthorized caller gets an EMPTY
-- result — the same defense-in-depth pattern as recent_audit_logs)
-- ============================================================================
begin;
select _oa_as('tom@chamama.example'); -- plain staff
do $$ begin
  declare v_count int;
  begin
    select count(*) into v_count from public.audit_logs_page(1, 20, null);
    if v_count <> 0 then
      raise exception 'FAIL: plain staff can read the audit log (%)', v_count;
    end if;
    if public.audit_logs_total(null) <> 0 then
      raise exception 'FAIL: plain staff can count the audit log';
    end if;
    if (select count(*) from public.audit_log_actors()) <> 0 then
      raise exception 'FAIL: plain staff can list audit actors';
    end if;
    raise notice 'PASS: audit pagination RPCs return nothing to unauthorized staff';
  end;
end $$;
rollback;

-- ============================================================================
-- AU2: pagination + actor filter COMPOSE (server-side, newest-first)
-- ============================================================================
begin;
select _oa_as('amit@chamama.example'); -- project_coordinator
do $$ begin
  declare
    r record; v int;
    v_base_all bigint; v_base_amit bigint;
  begin
    -- baselines before the fixed test rows (other audit rows may exist)
    v_base_all  := public.audit_logs_total(null);
    v_base_amit := public.audit_logs_total('11111111-1111-1111-1111-111111111108');

    -- fixed test data (as superuser): 5 rows, alternating actors, in the
    -- FUTURE so they are the newest; direct-table snapshot also as superuser
    -- (audit_logs has no client policies)
    perform set_config('role', 'postgres', true);
    delete from public.audit_logs where action = 'ov_audit_test';
    for v in 1..5 loop
      insert into public.audit_logs
        (actor_staff_id, action, entity_type, created_at)
      values
        (case when v % 2 = 0
              then '11111111-1111-1111-1111-111111111108'::uuid -- amit
              else '11111111-1111-1111-1111-111111111101'::uuid end, -- ronen
         'ov_audit_test', 'test',
         now() + make_interval(secs => v * 1000)); -- in the FUTURE: newest rows
    end loop;
    create temp table test_rows as
      select created_at, row_number() over (order by created_at desc) rn
        from public.audit_logs where action = 'ov_audit_test';
    grant select on test_rows to authenticated;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', '11111111-1111-1111-1111-111111111108', 'role', 'authenticated')::text, true);

    -- totals: +5 overall, +2 for amit's actor filter
    if public.audit_logs_total(null) <> v_base_all + 5 then
      raise exception 'FAIL: total should grow by exactly 5';
    end if;
    if public.audit_logs_total('11111111-1111-1111-1111-111111111108')
       <> v_base_amit + 2 then
      raise exception 'FAIL: filtered total should grow by exactly 2';
    end if;

    -- newest-first slice: page 2 of size 2 = the 3rd+4th newest TEST rows
    create temp table page_all as
      select row_number() over (order by created_at desc) rn, actor_staff_id, created_at
        from public.audit_logs_page(2, 2, null);
    if (select count(*) from page_all) <> 2 then
      raise exception 'FAIL: page 2 must hold exactly 2 rows';
    end if;
    select count(*) into v from page_all p
     where not exists (
       select 1 from test_rows g where g.rn in (3, 4) and g.created_at = p.created_at
     );
    if v <> 0 then raise exception 'FAIL: page 2 rows are not the expected newest-first slice'; end if;

    -- actor filter composes: every returned row for amit IS amit's (and the
    -- filtered page contains at least the 2 fixed test rows)
    create temp table page_actor as
      select actor_staff_id from public.audit_logs_page(1, 20, '11111111-1111-1111-1111-111111111108');
    if (select count(*) from page_actor) < 2
       or exists (select 1 from page_actor where actor_staff_id <> '11111111-1111-1111-1111-111111111108') then
      raise exception 'FAIL: actor filter + pagination do not compose';
    end if;

    -- safe columns only
    select * into r from public.audit_logs_page(1, 1, null) limit 1;
    if r.actor_name is null then raise exception 'FAIL: actor_name missing'; end if;
    raise notice 'PASS: audit pagination pages server-side and composes with the actor filter';
  end;
end $$;
rollback;

-- ============================================================================
-- AU3: audit_log_actors — actors represented in the log
-- ============================================================================
begin;
select _oa_as('ronen@chamama.example');
do $$ begin
  declare v_count int;
  begin
    perform set_config('role', 'postgres', true);
    delete from public.audit_logs where action = 'ov_audit_test';
    insert into public.audit_logs (actor_staff_id, action, entity_type)
    values ('11111111-1111-1111-1111-111111111105', 'ov_audit_test', 'test');
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', '11111111-1111-1111-1111-111111111101', 'role', 'authenticated')::text, true);

    perform public.audit_log_actors();
    select count(*) into v_count
      from public.audit_log_actors() where staff_id = '11111111-1111-1111-1111-111111111105';
    if v_count <> 1 then
      raise exception 'FAIL: audit_log_actors missing the represented actor';
    end if;
    -- name is resolved from the profile
    if not exists (
      select 1 from public.audit_log_actors()
       where staff_id = '11111111-1111-1111-1111-111111111105' and full_name = 'איתי גפן'
    ) then
      raise exception 'FAIL: actor name not resolved';
    end if;
    raise notice 'PASS: audit_log_actors lists log actors with names';
  end;
end $$;
rollback;

do $$ begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
\echo '--- override + audit test suite finished ---'
