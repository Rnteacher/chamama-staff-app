-- ============================================================================
-- Migration 20260923000001: HEBREW-COHORT EMPLOYMENT ELIGIBILITY +
--                           CALENDAR CSV IMPORT (operational UX correction pass)
--
-- PART A — EMPLOYMENT ELIGIBILITY FROM THE HOME-GROUP NAMING CONVENTION:
-- The home-group naming convention IS the canonical cohort order: the FIRST
-- HEBREW LETTER of the group name identifies the cohort (ארגמן=א ... זנגביל=ז).
-- The ACTIVE home group with the LATEST letter is always the YOUNGEST cohort;
-- the youngest cohort is NOT employment-eligible; every older active cohort IS.
-- This advances automatically when a new cohort group is added — nobody
-- updates student records.
--
--   hebrew_cohort_rank(name)        — explicit alphabet rank (א=1..ת=22,
--                                     final-letter forms normalized). NEVER
--                                     relies on string collation.
--   "current active home group"     — a group with ≥1 non-archived student
--                                     (canonical derivation from the existing
--                                     students.group_id relationship; there is
--                                     no group-active flag to invent).
--   student_employment_eligible(id) — REDEFINED (create or replace): student's
--                                     current group rank < max rank among
--                                     current groups. Invalid current group
--                                     names (no recognized Hebrew letter) are
--                                     NOT eligible and are surfaced as an
--                                     administrative warning — never guessed.
--   employment_cohort_status()      — admin diagnostics: per current group:
--                                     rank, active students, youngest flag,
--                                     name-validity (warning surface).
--   employment_admin_rows()         — RECREATED (shape change): school-year
--                                     column/parameter REMOVED; cohort
--                                     eligibility + note columns added.
--   student_employment_overview()   — re-asserted with a cohort_note and
--                                     without school_year semantics.
--
-- students.school_year is NOT dropped (already deployed; other surfaces may
-- still reference it) — employment simply stops using it as the source of
-- truth. No per-student year requirement remains in employment.
--
-- PART B — CALENDAR CSV IMPORT (leadership / super_admin only):
--   admin_import_calendar_events(p_events jsonb) — imports rows through the
--   CANONICAL admin_upsert_calendar_event (same validation, DST-safe
--   Jerusalem recurrence, same audit trail), inside ONE transaction: any
--   failed row rolls back the entire import (no partial silent corruption).
--   Audience NAME→ID resolution happens server-side in the app action; this
--   RPC re-validates everything canonically.
-- ============================================================================

-- ============================================================================
-- PART A
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Explicit Hebrew alphabet rank of the FIRST MEANINGFUL Hebrew letter of the
-- name. A leading generic "קבוצת" label (e.g. "קבוצת דוריאן") is skipped, as
-- are spaces/punctuation; the cohort letter itself decides (דוריאן=ד=4).
-- כ/ך, מ/ם, נ/ן, פ/ף, צ/ץ share ranks (final-letter normalization).
-- A name with NO recognized Hebrew letter returns NULL — callers must treat
-- that as "cannot determine cohort order" and surface a warning, NOT guess.
-- The result NEVER depends on string collation or sort order.
-- ---------------------------------------------------------------------------
create or replace function public.hebrew_cohort_rank(p_name text)
returns int
language plpgsql
immutable
as $$
declare
  v  text := btrim(coalesce(p_name, ''));
  i  int;
  ch text;
begin
  if v = '' then
    return null;
  end if;
  -- strip the generic leading label "קבוצת" (may repeat defensively)
  while left(v, 5) = 'קבוצת' loop
    v := btrim(substr(v, 6));
  end loop;
  for i in 1 .. length(v) loop
    ch := substr(v, i, 1);
    case ch
      when 'א' then return 1;
      when 'ב' then return 2;
      when 'ג' then return 3;
      when 'ד' then return 4;
      when 'ה' then return 5;
      when 'ו' then return 6;
      when 'ז' then return 7;
      when 'ח' then return 8;
      when 'ט' then return 9;
      when 'י' then return 10;
      when 'כ' then return 11;
      when 'ך' then return 11;
      when 'ל' then return 12;
      when 'מ' then return 13;
      when 'ם' then return 13;
      when 'נ' then return 14;
      when 'ן' then return 14;
      when 'ס' then return 15;
      when 'ע' then return 16;
      when 'פ' then return 17;
      when 'ף' then return 17;
      when 'צ' then return 18;
      when 'ץ' then return 18;
      when 'ק' then return 19;
      when 'ר' then return 20;
      when 'ש' then return 21;
      when 'ת' then return 22;
      else null; -- keep scanning for the first meaningful Hebrew letter
    end case;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- CANONICAL eligibility: ALL home-group cohorts EXCEPT the youngest one.
-- "Current" = every home group in greenhouse_groups (the school has no
-- group-active flag; completed cohorts follow the same naming convention and
-- carry EARLIER letters, so they can never affect the MAX — the latest letter
-- always belongs to the newest cohort). Adding a NEW cohort group — even
-- before it has students — makes it the youngest immediately, and the
-- previously-youngest cohort becomes eligible automatically. Nobody updates
-- student records.
-- ---------------------------------------------------------------------------
create or replace function public.student_employment_eligible(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select g.id,
           public.hebrew_cohort_rank(g.name) as cohort_rank
      from public.greenhouse_groups g
  ),
  youngest as (
    select max(cohort_rank) as max_rank from ranked
  )
  select coalesce((
    select r.cohort_rank < youngest.max_rank
      from ranked r cross join youngest
     where r.id = (select s.group_id from public.students s where s.id = p_student_id)
       and r.cohort_rank is not null
  ), false);
$$;

-- ---------------------------------------------------------------------------
-- Admin diagnostics: every home group with its cohort rank, youngest flag and
-- name validity. Invalid names surface as a visible warning ("לא ניתן לזהות
-- את סדר השנתון של הקבוצה") — never guessed.
-- employment_coordinator / leadership / super_admin only.
-- ---------------------------------------------------------------------------
create or replace function public.employment_cohort_status()
returns table (
  group_id      uuid,
  group_name    text,
  cohort_rank   int,
  active_students int,
  is_youngest   boolean,
  name_valid    boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.current_staff_id() is null
     or not public.staff_can_manage_employment(public.current_staff_id()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  with act as (
    select g.id,
           g.name,
           public.hebrew_cohort_rank(g.name) as rank,
           (select count(*) from public.students s
             where s.group_id = g.id and not s.is_archived) as students
      from public.greenhouse_groups g
  ),
  mx as (select max(rank) as max_rank from act)
  select c.id, c.name, c.rank, c.students::int,
         coalesce(c.rank = mx.max_rank, false),
         (c.rank is not null)
    from act c cross join mx
   order by c.rank nulls last, c.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- employment_admin_rows — RECREATED (shape change):
--   * school_year column + p_year filter REMOVED (no per-student year)
--   * includes EVERY active student with derived cohort eligibility + note
-- ---------------------------------------------------------------------------
drop function if exists public.employment_admin_rows(uuid, smallint, text, text, text);

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
         public.student_employment_eligible(s.id),
         case
           when cr.rank is null then
             'לא ניתן לזהות את סדר השנתון של הקבוצה ' || coalesce(g.name, '')
           when cr.rank = youngest.max_rank then
             'קבוצת השנתון הצעירה — לא נכללת בתוכנית התעסוקה'
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
    left join lateral (
      select * from public.student_employment_placements pl2
       where pl2.student_id = s.id
       order by pl2.is_active desc, pl2.start_date desc
       limit 1
    ) pl on true
   where not s.is_archived
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
-- student_employment_overview — re-asserted with cohort semantics (cohort_note
-- instead of school_year messaging). Shape preserved except the added note.
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
begin
  select * into v_place
    from public.student_employment_placements pl
   where pl.student_id = p_student_id
   order by pl.is_active desc, pl.start_date desc
   limit 1;

  v_minutes := public.student_employment_minutes(p_student_id);

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

  -- cohort note mirrors employment_admin_rows (youngest / invalid name)
  select case
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
-- PART B — CALENDAR CSV IMPORT (leadership / super_admin only)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Import rows through the CANONICAL admin_upsert_calendar_event (same
-- validation, DST-safe Jerusalem recurrence, same audit trail). ONE call =
-- ONE transaction: any failed row rolls back the ENTIRE import — no partial
-- silent corruption. Audience rows must already be RESOLVED to ids by the
-- server action; the upsert re-validates them canonically.
-- p_events: [{title, description?, start_date, start_time, end_date,
--             end_time, is_all_day, recurrence, recurrence_until?, audiences}]
-- ---------------------------------------------------------------------------
create or replace function public.admin_import_calendar_events(
  p_events jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_row   jsonb;
  v_eid   uuid;
  v_count int := 0;
  v_ids   uuid[] := '{}';
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not (
    public.staff_has_role(v_staff, 'leadership')
    or public.staff_has_role(v_staff, 'super_admin')
  ) then
    raise exception 'Only leadership or super_admin can import calendar events'
      using errcode = '42501';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) = 0 then
    raise exception 'אין אירועים לייבוא' using errcode = '23514';
  end if;
  if jsonb_array_length(p_events) > 500 then
    raise exception 'יותר מדי אירועים בייבוא (מוגבל ל־500)' using errcode = '23514';
  end if;

  for v_row in select * from jsonb_array_elements(p_events) loop
    select (public.admin_upsert_calendar_event(
              null,
              v_row ->> 'title',
              nullif(v_row ->> 'description', ''),
              (v_row ->> 'start_date')::date,
              nullif(v_row ->> 'start_time', '')::time,
              (v_row ->> 'end_date')::date,
              nullif(v_row ->> 'end_time', '')::time,
              coalesce((v_row ->> 'is_all_day')::boolean, false),
              coalesce(v_row ->> 'recurrence', 'none'),
              nullif(v_row ->> 'recurrence_until', '')::date,
              v_row -> 'audiences'
            ) ->> 'id')::uuid
      into v_eid;
    if v_eid is null then
      raise exception 'ייבוא נכשל בשורה: %', coalesce(v_row ->> 'title', '?')
        using errcode = '23514';
    end if;
    v_count := v_count + 1;
    v_ids   := v_ids || v_eid;
  end loop;

  return jsonb_build_object('imported', v_count, 'event_ids', to_jsonb(v_ids));
end;
$$;

-- ============================================================================
-- Grants
-- ============================================================================
revoke all on function public.hebrew_cohort_rank(text)                from public, anon;
revoke all on function public.student_employment_eligible(uuid)       from public, anon;
revoke all on function public.employment_cohort_status()              from public, anon;
revoke all on function public.employment_admin_rows(uuid, text, text, text) from public, anon;
revoke all on function public.student_employment_overview(uuid)       from public, anon;
revoke all on function public.admin_import_calendar_events(jsonb)     from public, anon;

grant execute on function public.hebrew_cohort_rank(text)          to authenticated, service_role;
grant execute on function public.student_employment_eligible(uuid) to authenticated, service_role;
grant execute on function public.employment_cohort_status()        to authenticated;
grant execute on function public.employment_admin_rows(uuid, text, text, text) to authenticated;
grant execute on function public.student_employment_overview(uuid) to authenticated;
grant execute on function public.admin_import_calendar_events(jsonb) to authenticated;
