-- ============================================================================
-- Employment semantics (migration 20260923000008).
--   supabase db reset && psql -f supabase/tests/employment_semantics_tests.sql
--
--   youngest cohort, no add        -> not eligible
--   youngest cohort, added         -> eligible
--   older cohort                   -> eligible
--   older + legacy force-ineligible -> STILL eligible
-- Every consumer agrees: the canonical function, the student-page overview
-- and the management list. Seed: "קבוצת שקד" is the youngest cohort.
-- Every test runs in its own transaction and rolls back.
-- ============================================================================

\echo '--- starting employment semantics test suite ---'

create or replace function pg_temp.act_as(p_email text)
returns void language plpgsql as $$
declare v_uid uuid;
begin
  select auth_user_id into v_uid from public.profiles where email = p_email;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
end;
$$;

-- one student through every consumer: function / overview / admin list
create or replace function pg_temp.check_student(p_student uuid, p_expected boolean, p_label text)
returns void language plpgsql as $$
declare v_fn boolean; v_ov boolean; v_listed boolean;
begin
  perform pg_temp.act_as('itay@chamama.example'); -- employment coordinator
  v_fn := public.student_employment_eligible(p_student);
  v_ov := (public.student_employment_overview(p_student)->>'eligible')::boolean;
  v_listed := exists (select 1 from public.employment_admin_rows() r where r.student_id = p_student);
  if v_fn is distinct from p_expected or v_ov is distinct from p_expected or v_listed is distinct from p_expected then
    raise exception 'FAIL: % — expected %, got function=% overview=% admin_list=%',
      p_label, p_expected, v_fn, v_ov, v_listed;
  end if;
end;
$$;

-- ES1: youngest default -> not eligible (everywhere)
begin;
do $$ begin
  perform pg_temp.check_student('44444444-4444-4444-4444-444444444406', false, 'ES1 youngest default');
  raise notice 'PASS: youngest cohort default is not eligible (function, overview, admin list)';
end $$;
rollback;

-- ES2: youngest + explicit add -> eligible
begin;
do $$ begin
  perform pg_temp.act_as('itay@chamama.example');
  perform public.admin_set_employment_override('44444444-4444-4444-4444-444444444406', 'eligible');
  perform pg_temp.check_student('44444444-4444-4444-4444-444444444406', true, 'ES2 youngest added');
  raise notice 'PASS: youngest cohort + explicit add is eligible everywhere';
end $$;
rollback;

-- ES3: older default -> eligible
begin;
do $$ begin
  perform pg_temp.check_student('44444444-4444-4444-4444-444444444403', true, 'ES3 older default');
  perform pg_temp.check_student('44444444-4444-4444-4444-44444444440e', true, 'ES3 oldest cohort');
  raise notice 'PASS: older cohorts are eligible automatically';
end $$;
rollback;

-- ES4: older + legacy force-ineligible -> STILL eligible; the row is kept
begin;
insert into public.student_employment_overrides (student_id, override)
values ('44444444-4444-4444-4444-444444444403', 'ineligible'),
       ('44444444-4444-4444-4444-44444444440e', 'ineligible');
do $$ begin
  perform pg_temp.check_student('44444444-4444-4444-4444-444444444403', true, 'ES4 older + legacy deny');
  perform pg_temp.check_student('44444444-4444-4444-4444-44444444440e', true, 'ES4 oldest + legacy deny');
  if (select count(*) from public.student_employment_overrides where override = 'ineligible') <> 2 then
    raise exception 'FAIL: ES4 legacy rows must be left untouched';
  end if;
  raise notice 'PASS: legacy force-ineligible never hides an older student (rows untouched)';
end $$;
rollback;

-- ES5: legacy force-ineligible on the youngest = the default (not eligible)
begin;
insert into public.student_employment_overrides (student_id, override)
values ('44444444-4444-4444-4444-444444444406', 'ineligible');
do $$ begin
  perform pg_temp.check_student('44444444-4444-4444-4444-444444444406', false, 'ES5 youngest + legacy deny');
  raise notice 'PASS: legacy force-ineligible on the youngest changes nothing';
end $$;
rollback;

-- ES6: no way to write force-ineligible any more; add/clear still work
begin;
do $$ begin
  perform pg_temp.act_as('itay@chamama.example');
  begin
    perform public.admin_set_employment_override('44444444-4444-4444-4444-444444444403', 'ineligible');
    raise exception 'FAIL: ES6 force-ineligible accepted';
  exception when invalid_parameter_value then null; end;
  if exists (select 1 from public.student_employment_overrides) then
    raise exception 'FAIL: ES6 a refused call wrote a row';
  end if;
  perform public.admin_set_employment_override('44444444-4444-4444-4444-444444444406', 'eligible');
  perform public.admin_set_employment_override('44444444-4444-4444-4444-444444444406', 'automatic');
  if exists (select 1 from public.student_employment_overrides) then
    raise exception 'FAIL: ES6 automatic must clear the add';
  end if;
  -- still manager-only
  perform pg_temp.act_as('tom@chamama.example');
  begin
    perform public.admin_set_employment_override('44444444-4444-4444-4444-444444444406', 'eligible');
    raise exception 'FAIL: ES6 plain staff added a student';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: force-ineligible refused; add/clear unchanged and manager-only';
end $$;
rollback;

\echo '--- employment semantics test suite finished ---'
