-- ============================================================================
-- Migration 20260923000002: EMPLOYMENT ELIGIBILITY MANUAL OVERRIDE (TRI-STATE)
--                           + AUDIT LOG PAGINATION / ACTOR FILTER
--                           (UX-corrections pass — fully additive)
--
-- PART A — EMPLOYMENT ELIGIBILITY MANUAL OVERRIDE:
-- The canonical default rule is unchanged (every current Hebrew-letter cohort
-- EXCEPT the youngest). On top of it, an authorized employment manager may
-- record an explicit PER-STUDENT decision. The override is TRI-STATE — a
-- missing row means "automatic" (never conflated with an explicit allow/deny):
--
--   student_employment_overrides      — at most one row per student
--                                       (override ∈ 'eligible' | 'ineligible')
--   student_employment_eligible(id)   — REDEFINED (create or replace):
--                                       1. explicit override if present
--                                       2. otherwise the cohort default
--                                       ONE canonical function — placement
--                                       creation, admin rows and the overview
--                                       all go through it, so the rule is
--                                       never duplicated in the app.
--   admin_set_employment_override()   — set/clear the override (audited).
--                                       employment_coordinator / leadership /
--                                       super_admin only. View-As is blocked
--                                       in the app layer (assertNotViewAs).
--   employment_admin_rows()           — RECREATED: only EFFECTIVELY-eligible
--                                       students are listed (the youngest
--                                       auto-ineligible cohort disappears
--                                       unless explicitly forced eligible;
--                                       forced-ineligible students disappear
--                                       even from older cohorts); the effective
--                                       override is exposed for diagnostics.
--   student_employment_overview()     — re-asserted: adds the current override
--                                       so the student page can render the
--                                       tri-state control.
--
-- The overrides table has RLS enabled and NO client policies: it is reached
-- exclusively through the security-definer RPCs above (same pattern as
-- audit_logs).
--
-- PART B — AUDIT LOG PAGINATION + ACTOR FILTER (additive; the existing
-- recent_audit_logs() stays untouched):
--   audit_logs_page(p_page, p_page_size, p_actor)
--                                     — server-side pagination (LIMIT/OFFSET),
--                                       newest-first, optional actor filter.
--                                       Safe columns only: timestamp, actor,
--                                       humanized action, entity — NEVER
--                                       message/report contents.
--   audit_logs_total(p_actor)         — one count for the pager.
--   audit_log_actors()                — distinct actors present in the log
--                                       (for the "איש/אשת צוות" filter).
--   idx_audit_logs_actor_created      — index for the filtered newest-first scan.
-- ============================================================================

-- ============================================================================
-- PART A
-- ============================================================================

-- ---------------------------------------------------------------------------
-- One explicit decision per student. No row = automatic (cohort default).
-- 'eligible' = force eligible, 'ineligible' = force ineligible.
-- ---------------------------------------------------------------------------
create table public.student_employment_overrides (
  student_id uuid primary key references public.students (id) on delete cascade,
  override   text not null check (override in ('eligible', 'ineligible')),
  set_by     uuid references public.profiles (id) on delete set null,
  set_at     timestamptz not null default now()
);

alter table public.student_employment_overrides enable row level security;

-- no client policies: access flows ONLY through the security-definer RPCs
-- (service_role bypasses RLS for administrative reads if ever needed).

-- ---------------------------------------------------------------------------
-- CANONICAL effective eligibility — ONE function for every consumer:
--   1. explicit override if present (force eligible / force ineligible)
--   2. otherwise the Hebrew-cohort default (all cohorts except the youngest)
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
  -- 1) explicit human decision wins (tri-state: row present = decided)
  select o.override
    into v_override
    from public.student_employment_overrides o
   where o.student_id = p_student_id;

  if v_override = 'eligible' then
    return true;
  end if;
  if v_override = 'ineligible' then
    return false;
  end if;

  -- 2) cohort default: latest Hebrew-letter cohort is the youngest and is
  --    NOT eligible; every older (or unreadable-name) cohort/student is not
  --    eligible either when the rank cannot be determined (never guessed).
  select public.hebrew_cohort_rank(g.name)
    into v_rank
    from public.students s
    left join public.greenhouse_groups g on g.id = s.group_id
   where s.id = p_student_id;

  select max(public.hebrew_cohort_rank(g2.name))
    into v_max_rank
    from public.greenhouse_groups g2;

  return coalesce(v_rank is not null and v_rank < v_max_rank, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Set / clear the per-student override. employment_coordinator / leadership /
-- super_admin ONLY (same helper as every other employment mutation).
-- p_override: 'eligible' | 'ineligible' | 'automatic' (clears any override).
-- Audited: employment_override_set / _changed / _reset with prev → next.
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
  if p_override not in ('eligible', 'ineligible', 'automatic') then
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

-- ---------------------------------------------------------------------------
-- employment_admin_rows — RECREATED: lists ONLY effectively-eligible students
-- (youngest auto-ineligible cohort hidden; forced-ineligible hidden; forced-
-- eligible youngest visible). The effective override is surfaced for
-- diagnostics (null = automatic).
-- ---------------------------------------------------------------------------
drop function if exists public.employment_admin_rows(uuid, text, text, text);

create or replace function public.employment_admin_rows(
  p_group_id uuid default null,
  p_workplace text default null,
  p_status text default null,
  p_progress text default null
)
returns table (
  student_id       uuid,
  student_name     text,
  group_name       text,
  employment_eligible boolean,
  override         text,
  cohort_note      text,
  placement_id     uuid,
  workplace_name   text,
  placement_active boolean,
  slots_summary    text,
  total_minutes    int,
  target_minutes   int
)
language sql
stable
security definer
set search_path = public
as $$
  with weekdays as (
    select unnest(array['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת']) as name,
           generate_series(0, 6) as idx
  ),
  cur_ranks as (
    select g.id,
           public.hebrew_cohort_rank(g.name) as rank
      from public.greenhouse_groups g
  ),
  youngest as (select max(rank) as max_rank from cur_ranks)
  select s.id,
         s.first_name || ' ' || s.last_name,
         g.name,
         true as employment_eligible,
         o.override,
         case
           when o.override is not null then null
           when cr.rank = youngest.max_rank then
             'קבוצת השנתון הצעירה — שולבה ידנית בתוכנית התעסוקה'
           else null
         end as cohort_note,
         pl.id,
         pl.workplace_name,
         pl.is_active,
         coalesce((
           select string_agg('יום ' || wd.name || ' ' ||
                    to_char(w.start_time, 'HH24:MI') || '–' || to_char(w.end_time, 'HH24:MI'),
                    ' · ' order by w.weekday, w.start_time)
             from public.student_employment_weekly_slots w
             join weekdays wd on wd.idx = w.weekday
            where w.placement_id = pl.id
         ), '') as slots_summary,
         public.student_employment_minutes(s.id) as total_minutes,
         12000 as target_minutes
    from public.students s
    left join public.greenhouse_groups g on g.id = s.group_id
    left join cur_ranks cr on cr.id = s.group_id
    cross join youngest
    left join public.student_employment_overrides o on o.student_id = s.id
    left join lateral (
      select * from public.student_employment_placements pl2
       where pl2.student_id = s.id
       order by pl2.is_active desc, pl2.start_date desc
       limit 1
    ) pl on true
   where not s.is_archived
     and public.student_employment_eligible(s.id)
     and (p_group_id is null or s.group_id = p_group_id)
     and (p_workplace is null or pl.workplace_name ilike '%' || btrim(p_workplace) || '%')
     and (
       p_status is null
       or (p_status = 'active' and pl.is_active)
       or (p_status = 'ended' and pl.id is not null and not pl.is_active)
       or (p_status = 'none' and pl.id is null)
     )
     and (
       p_progress is null
       or (p_progress = 'below' and public.student_employment_minutes(s.id) < 12000)
       or (p_progress = 'at'    and public.student_employment_minutes(s.id) = 12000)
       or (p_progress = 'above' and public.student_employment_minutes(s.id) > 12000)
     )
   order by s.first_name, s.last_name;
$$;

-- ---------------------------------------------------------------------------
-- student_employment_overview — re-asserted: exposes the current override
-- (null = automatic) and keeps the cohort note only for automatic students
-- (an explicit decision is shown by the tri-state control, not by a note).
-- ---------------------------------------------------------------------------
create or replace function public.student_employment_overview(
  p_student_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_can_manage boolean := public.staff_can_manage_employment(v_staff);
  v_place record;
  v_minutes int;
  v_slots jsonb;
  v_exceptions jsonb;
  v_recent jsonb;
  v_note text;
  v_override text;
begin
  select * into v_place
    from public.student_employment_placements pl
   where pl.student_id = p_student_id
   order by pl.is_active desc, pl.start_date desc
   limit 1;

  v_minutes := public.student_employment_minutes(p_student_id);

  select o.override into v_override
    from public.student_employment_overrides o
   where o.student_id = p_student_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'weekday', w.weekday, 'start_time', w.start_time, 'end_time', w.end_time)
           order by w.weekday, w.start_time), '[]'::jsonb)
    into v_slots
    from public.student_employment_weekly_slots w
   where v_place.id is not null and w.placement_id = v_place.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'work_date', e.work_date, 'kind', e.kind,
           'start_time', e.start_time, 'end_time', e.end_time)
           order by e.work_date), '[]'::jsonb)
    into v_exceptions
    from public.student_employment_exceptions e
   where v_place.id is not null and e.placement_id = v_place.id
     and e.work_date >= current_date - 30
     and e.work_date <= current_date + 60;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'work_date', l.work_date, 'start_time', l.start_time,
           'end_time', l.end_time, 'duration_minutes', l.duration_minutes,
           'note', case when v_can_manage then l.note else null end)
           order by l.work_date desc, l.created_at desc), '[]'::jsonb)
    into v_recent
    from (select * from public.student_employment_work_logs
           where student_id = p_student_id
           order by work_date desc, created_at desc
           limit 10) l;

  -- cohort note mirrors employment_admin_rows (youngest / invalid name),
  -- suppressed when an explicit override is in force
  select case
           when v_override is not null then null
           when cr.rank is null then
             'לא ניתן לזהות את סדר השנתון של הקבוצה ' || coalesce(g.name, '')
           when cr.rank = y.max_rank then
             'קבוצת השנתון הצעירה — לא נכללת בתוכנית התעסוקה'
           else null
         end
    into v_note
    from public.students s
    left join public.greenhouse_groups g on g.id = s.group_id
    left join lateral (
      select public.hebrew_cohort_rank(g2.name) as rank,
             (select count(*) from public.students s3
               where s3.group_id = g2.id and not s3.is_archived) as students
        from public.greenhouse_groups g2
       where g2.id = s.group_id
    ) cr on true
    cross join lateral (
      select max(public.hebrew_cohort_rank(g3.name)) as max_rank
        from public.greenhouse_groups g3
    ) y
   where s.id = p_student_id;

  return jsonb_build_object(
    'eligible', public.student_employment_eligible(p_student_id),
    'override', v_override,
    'cohort_note', v_note,
    'placement', case when v_place.id is null then null else jsonb_build_object(
      'id', v_place.id,
      'workplace_name', v_place.workplace_name,
      'contact_name', case when v_can_manage then v_place.contact_name else null end,
      'contact_phone', case when v_can_manage then v_place.contact_phone else null end,
      'start_date', v_place.start_date,
      'end_date', v_place.end_date,
      'is_active', v_place.is_active,
      'notes', case when v_can_manage then v_place.notes else null end
    ) end,
    'weekly_slots', v_slots,
    'exceptions', v_exceptions,
    'total_minutes', v_minutes,
    'target_minutes', 12000,
    'recent_logs', v_recent,
    'can_manage', v_can_manage
  );
end;
$$;

-- ============================================================================
-- PART B — AUDIT LOG PAGINATION + ACTOR FILTER
-- ============================================================================

create index if not exists idx_audit_logs_actor_created
  on public.audit_logs (actor_staff_id, created_at desc);

-- ---------------------------------------------------------------------------
-- One page of the activity log — newest-first, server-side pagination,
-- optional actor filter. Safe columns only (timestamp / actor / action /
-- entity) — message/report contents are NEVER exposed. Same authorization
-- as recent_audit_logs: project coordinator or super_admin.
-- ---------------------------------------------------------------------------
create or replace function public.audit_logs_page(
  p_page      int default 1,
  p_page_size int default 20,
  p_actor     uuid default null
)
returns table (
  created_at     timestamptz,
  actor_staff_id uuid,
  actor_name     text,
  action         text,
  entity_type    text,
  entity_id      uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select public.current_staff_id() as sid
     where public.current_staff_id() is not null
       and (
         public.staff_has_role(public.current_staff_id(), 'super_admin')
         or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
       )
  )
  select l.created_at,
         l.actor_staff_id,
         coalesce(p.full_name, '—'),
         l.action,
         l.entity_type,
         l.entity_id
    from public.audit_logs l
    left join public.profiles p on p.id = l.actor_staff_id
    cross join authorized a
   where a.sid is not null
     and (p_actor is null or l.actor_staff_id = p_actor)
   order by l.created_at desc
   limit greatest(1, least(coalesce(p_page_size, 20), 100))
   offset greatest(0, coalesce(p_page, 1) - 1)
        * greatest(1, least(coalesce(p_page_size, 20), 100));
$$;

-- ---------------------------------------------------------------------------
-- Total matching rows (for the pager) — same authorization + actor filter.
-- ---------------------------------------------------------------------------
create or replace function public.audit_logs_total(p_actor uuid default null)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
    from public.audit_logs l
   where public.current_staff_id() is not null
     and (
       public.staff_has_role(public.current_staff_id(), 'super_admin')
       or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
     )
     and (p_actor is null or l.actor_staff_id = p_actor);
$$;

-- ---------------------------------------------------------------------------
-- Distinct actors represented in the log (for the "איש/אשת צוות" filter).
-- ---------------------------------------------------------------------------
create or replace function public.audit_log_actors()
returns table (
  staff_id  uuid,
  full_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct l.actor_staff_id, coalesce(p.full_name, '—')
    from public.audit_logs l
    join public.profiles p on p.id = l.actor_staff_id
   where public.current_staff_id() is not null
     and (
       public.staff_has_role(public.current_staff_id(), 'super_admin')
       or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
     )
     and l.actor_staff_id is not null
   order by 2;
$$;

-- ============================================================================
-- Grants
-- ============================================================================
revoke all on function public.student_employment_eligible(uuid)              from public, anon;
revoke all on function public.admin_set_employment_override(uuid, text)      from public, anon;
revoke all on function public.employment_admin_rows(uuid, text, text, text)  from public, anon;
revoke all on function public.student_employment_overview(uuid)              from public, anon;
revoke all on function public.audit_logs_page(int, int, uuid)                from public, anon;
revoke all on function public.audit_logs_total(uuid)                         from public, anon;
revoke all on function public.audit_log_actors()                             from public, anon;

grant execute on function public.student_employment_eligible(uuid)              to authenticated, service_role;
grant execute on function public.admin_set_employment_override(uuid, text)      to authenticated;
grant execute on function public.employment_admin_rows(uuid, text, text, text)  to authenticated;
grant execute on function public.student_employment_overview(uuid)              to authenticated;
grant execute on function public.audit_logs_page(int, int, uuid)                to authenticated;
grant execute on function public.audit_logs_total(uuid)                         to authenticated;
grant execute on function public.audit_log_actors()                             to authenticated;
