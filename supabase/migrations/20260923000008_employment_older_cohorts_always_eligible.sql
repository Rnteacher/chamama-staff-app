-- ============================================================================
-- Migration 20260923000008: EMPLOYMENT — OLDER COHORTS ARE ALWAYS ELIGIBLE
--
-- Additive. Applied AFTER 20260923000007. No deployed migration file is
-- modified; both functions keep their exact signatures (CREATE OR REPLACE,
-- body-only changes). No data is changed or deleted.
--
-- Product rule (replaces the tri-state allow/deny semantics of 000002):
--   * every OLDER cohort: employment applies automatically — there is no
--     manual deny, and a legacy 'ineligible' override row is ignored;
--   * the YOUNGEST cohort (and a student whose cohort cannot be determined):
--     not eligible unless explicitly ADDED ('eligible' override) — the only
--     meaningful manual override.
--
-- 1. student_employment_eligible(id) — the ONE canonical function (placement
--    creation, employment_admin_rows, student_employment_overview and every
--    other consumer go through it) now expresses that rule.
-- 2. admin_set_employment_override() — refuses new 'ineligible' writes;
--    'eligible' (add) and 'automatic' (clear) are unchanged, as are the
--    authorization and the audit trail.
--
-- Legacy 'ineligible' rows (none in production when this was written) stay
-- in student_employment_overrides untouched and are behaviorally irrelevant;
-- the table's check constraint is deliberately left as is so no existing row
-- can make this migration fail.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CANONICAL effective eligibility
-- ---------------------------------------------------------------------------
create or replace function public.student_employment_eligible(p_student_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_override text;
  v_rank     int;
  v_max_rank int;
begin
  -- cohort: the latest Hebrew-letter cohort is the youngest
  select public.hebrew_cohort_rank(g.name)
    into v_rank
    from public.students s
    left join public.greenhouse_groups g on g.id = s.group_id
   where s.id = p_student_id;

  select max(public.hebrew_cohort_rank(g2.name))
    into v_max_rank
    from public.greenhouse_groups g2;

  -- 1) every older cohort: automatic, no manual deny (legacy 'ineligible'
  --    rows are ignored)
  if v_rank is not null and v_rank < v_max_rank then
    return true;
  end if;

  -- 2) youngest cohort / undeterminable cohort: only an explicit add counts
  select o.override
    into v_override
    from public.student_employment_overrides o
   where o.student_id = p_student_id;

  return coalesce(v_override = 'eligible', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Set / clear the per-student override — 'eligible' (add) | 'automatic'
--    (clear). 'ineligible' is no longer accepted. employment_coordinator /
--    leadership / super_admin only; audited exactly as before.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_employment_override(
  p_student_id uuid,
  p_override   text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_prev  text;
begin
  if v_staff is null
     or not public.staff_can_manage_employment(v_staff) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_student_id is null or not exists (
    select 1 from public.students s
     where s.id = p_student_id and not s.is_archived
  ) then
    raise exception 'Student not found' using errcode = '23503';
  end if;
  if p_override is null or p_override not in ('eligible', 'automatic') then
    raise exception 'Invalid override value' using errcode = '22023';
  end if;

  select o.override
    into v_prev
    from public.student_employment_overrides o
   where o.student_id = p_student_id;

  if p_override = 'automatic' then
    delete from public.student_employment_overrides
     where student_id = p_student_id;
  else
    insert into public.student_employment_overrides (student_id, override, set_by)
    values (p_student_id, p_override, v_staff)
    on conflict (student_id) do update
      set override = excluded.override,
          set_by   = excluded.set_by,
          set_at   = now();
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (
    v_staff,
    case
      when p_override = 'automatic' then 'employment_override_reset'
      when v_prev is null           then 'employment_override_set'
      else 'employment_override_changed'
    end,
    'student',
    p_student_id,
    jsonb_build_object('from', coalesce(v_prev, 'automatic'), 'to', p_override)
  );

  return true;
end;
$$;
