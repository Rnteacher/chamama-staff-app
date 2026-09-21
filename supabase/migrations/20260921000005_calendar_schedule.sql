-- ============================================================================
-- Migration 20260921000005: ANNUAL CALENDAR + UNIFIED DAILY SCHEDULE +
-- MEETING CONFLICT DETECTION (phase 2 of daily operations)
--
-- Adds:
--   calendar_events            — canonical event model with STRUCTURED
--                                recurrence (none/weekly/monthly), NOT a
--                                boolean and NOT UTC-step arithmetic:
--                                wall-clock dates/times are stored in
--                                Asia/Jerusalem semantics and concrete
--                                occurrences are composed per-date with
--                                (date + time) AT TIME ZONE 'Asia/Jerusalem',
--                                so a 10:00 event stays 10:00 across DST.
--   calendar_event_audiences   — normalized audience rows (no polymorphic
--                                JSON): everyone / staff_only / home_group /
--                                major / learning_group / staff_member with
--                                typed FK integrity checks.
--   canonical occurrence expansion (calendar_event_occurrences) used by the
--   calendar UI, the unified daily schedule and conflict detection.
--   staff_day_schedule / student_day_schedule — unified aggregation RPCs
--   (events + meetings + learning groups; employment can later be added as
--   another source without redesigning the API).
--   check_student_meeting_conflicts — server-backed conflict warnings.
--
-- Recurrence requires an explicit `recurrence_until` (bounded ≤ 2 years) —
-- no accidental infinite recurrence.
--
-- Permissions: leadership / super_admin manage (in-RPC checks + audit);
-- authorized staff read. No anon access anywhere. View-As mutations are
-- blocked in the app layer before any RPC is invoked.
--
-- Audit: calendar_event_created / calendar_event_updated /
-- calendar_event_deleted (metadata contains ids/titles only — never the
-- event description).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- calendar_events
-- Times are Jerusalem WALL-CLOCK components. For recurring events every
-- occurrence is composed at the same wall time on its occurrence date, so
-- local time survives DST transitions by construction.
-- ---------------------------------------------------------------------------
create table public.calendar_events (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null check (length(btrim(title)) between 1 and 200),
  description         text check (description is null or length(btrim(description)) <= 2000),
  -- wall-clock representation (Asia/Jerusalem)
  start_date          date not null,
  start_time          time not null,
  end_date            date not null,
  end_time            time not null,
  is_all_day          boolean not null default false,
  recurrence          text not null default 'none'
                        check (recurrence in ('none', 'weekly', 'monthly')),
  -- inclusive last Jerusalem date on which an occurrence may START
  recurrence_until    date,
  status              text not null default 'active' check (status in ('active', 'cancelled')),
  deleted_at          timestamptz,
  created_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint calendar_event_period_valid check (
    end_date > start_date or (end_date = start_date and end_time > start_time)
  ),
  constraint calendar_event_recurring_until_required check (
    recurrence = 'none' or recurrence_until is not null
  ),
  constraint calendar_event_recurring_until_bounds check (
    recurrence = 'none' or recurrence_until >= start_date
  ),
  -- bounded recurrence horizon: a school-system event cannot recur forever
  constraint calendar_event_recurring_until_cap check (
    recurrence = 'none' or recurrence_until <= start_date + 730
  )
);

comment on table public.calendar_events is
  'Canonical calendar events. All date/time fields are Asia/Jerusalem wall-clock. '
  'recurrence: none | weekly (every 7 days from start_date) | monthly (same day-of-month). '
  'recurrence_until is REQUIRED for recurring events (bounded school-year horizon).';

create index idx_calendar_events_range      on public.calendar_events (start_date, end_date);
create index idx_calendar_events_recurrence on public.calendar_events (recurrence, recurrence_until);
create index idx_calendar_events_status     on public.calendar_events (status, deleted_at);

-- ---------------------------------------------------------------------------
-- calendar_event_audiences — one row per audience binding; typed FK checks
-- make polymorphic references impossible to corrupt.
-- ---------------------------------------------------------------------------
create table public.calendar_event_audiences (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references public.calendar_events (id) on delete cascade,
  audience_type      text not null check (audience_type in
                       ('everyone', 'staff_only', 'home_group', 'major',
                        'learning_group', 'staff_member')),
  greenhouse_group_id uuid references public.greenhouse_groups (id) on delete cascade,
  major_id           uuid references public.majors (id) on delete cascade,
  learning_group_id  uuid references public.learning_groups (id) on delete cascade,
  staff_id           uuid references public.profiles (id) on delete cascade,
  constraint calendar_audience_everyone_no_refs check (
    audience_type not in ('everyone', 'staff_only')
    or (greenhouse_group_id is null and major_id is null
        and learning_group_id is null and staff_id is null)
  ),
  constraint calendar_audience_home_group_ref check (
    audience_type <> 'home_group'
    or (greenhouse_group_id is not null and major_id is null
        and learning_group_id is null and staff_id is null)
  ),
  constraint calendar_audience_major_ref check (
    audience_type <> 'major'
    or (major_id is not null and greenhouse_group_id is null
        and learning_group_id is null and staff_id is null)
  ),
  constraint calendar_audience_learning_group_ref check (
    audience_type <> 'learning_group'
    or (learning_group_id is not null and greenhouse_group_id is null
        and major_id is null and staff_id is null)
  ),
  constraint calendar_audience_staff_member_ref check (
    audience_type <> 'staff_member'
    or (staff_id is not null and greenhouse_group_id is null
        and major_id is null and learning_group_id is null)
  )
);

-- no duplicate bindings of the same kind to the same target
create unique index idx_calendar_audience_unique
  on public.calendar_event_audiences (
    event_id, audience_type,
    coalesce(greenhouse_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(major_id,           '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(learning_group_id,  '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(staff_id,           '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index idx_calendar_audiences_event on public.calendar_event_audiences (event_id);
create index idx_calendar_audiences_group on public.calendar_event_audiences (greenhouse_group_id);
create index idx_calendar_audiences_major on public.calendar_event_audiences (major_id);
create index idx_calendar_audiences_lg    on public.calendar_event_audiences (learning_group_id);
create index idx_calendar_audiences_staff on public.calendar_event_audiences (staff_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['calendar_events']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;

-- ============================================================================
-- TIME COMPOSITION (DST-critical)
-- Wall-clock date + time → absolute instant, per Asia/Jerusalem. Repeatedly
-- adding 24h/7d to a UTC instant is FORBIDDEN — always recompose from the
-- wall components so a 10:00 event remains 10:00 through DST changes.
-- ============================================================================
create or replace function public.compose_jerusalem(p_date date, p_time time)
returns timestamptz
language sql
immutable
as $$
  select (p_date + p_time) at time zone 'Asia/Jerusalem';
$$;

-- ============================================================================
-- CANONICAL OCCURRENCE EXPANSION — the ONE server-side expander.
-- Calendar display, daily schedules and conflict detection all consume this.
-- ============================================================================
create or replace function public.calendar_event_occurrences(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  event_id              uuid,
  title                 text,
  description           text,
  is_all_day            boolean,
  recurrence            text,
  status                text,
  occurrence_start      timestamptz,
  occurrence_end        timestamptz,
  occurrence_start_date date,
  occurrence_end_date   date
)
language sql
stable
security definer
set search_path = public
as $$
  with events as (
    select *
      from public.calendar_events
     where status = 'active'
       and deleted_at is null
       -- cheap range prefilter on wall dates (occurrence must intersect range)
       and compose_jerusalem(start_date, start_time) <= p_to + interval '1 day'
       and (
         (recurrence = 'none'
           and compose_jerusalem(end_date, end_time) >= p_from)
         or (recurrence = 'weekly'
           and recurrence_until >= (p_from at time zone 'Asia/Jerusalem')::date - (end_date - start_date))
         or (recurrence = 'monthly'
           and recurrence_until >= (p_from at time zone 'Asia/Jerusalem')::date - (end_date - start_date))
       )
  ),
  weekly_dates as (
    select e.id, e.start_date + (k * 7) as occ_start_date
      from events e
      cross join lateral generate_series(
        0,
        floor((coalesce(e.recurrence_until, e.start_date) - e.start_date) / 7)::int
      ) as k
     where e.recurrence = 'weekly'
       and e.start_date + (k * 7) <= e.recurrence_until
  ),
  monthly_dates as (
    select e.id, make_date(my, mm, md) as occ_start_date
      from events e
      cross join lateral generate_series(
        0,
        (extract(year  from coalesce(e.recurrence_until, e.start_date))::int
         - extract(year  from e.start_date)::int) * 12
         + (extract(month from coalesce(e.recurrence_until, e.start_date))::int
         - extract(month from e.start_date)::int)
      ) as k
      cross join lateral (
        select (date_trunc('month', e.start_date) + make_interval(months => k))::date as month_start
      ) mth
      cross join lateral (
        select extract(year  from mth.month_start)::int as my,
               extract(month from mth.month_start)::int as mm,
               extract(day   from e.start_date)::int    as md
      ) parts
     where e.recurrence = 'monthly'
       -- months lacking the day-of-month are skipped (e.g. Jan 31 → Feb)
       and md <= extract(day from (mth.month_start + interval '1 month - 1 day'))::int
       and make_date(my, mm, md) <= coalesce(e.recurrence_until, e.start_date)
  ),
  occurrence_dates as (
    select id, start_date as occ_start_date from events where recurrence = 'none'
    union all
    select id, occ_start_date from weekly_dates
    union all
    select id, occ_start_date from monthly_dates
  )
  select e.id, e.title, e.description, e.is_all_day, e.recurrence, e.status,
         public.compose_jerusalem(d.occ_start_date, e.start_time)
           as occurrence_start,
         public.compose_jerusalem(
           d.occ_start_date + (e.end_date - e.start_date), e.end_time
         ) as occurrence_end,
         d.occ_start_date,
         d.occ_start_date + (e.end_date - e.start_date)
           as occurrence_end_date
    from events e
    join occurrence_dates d on d.id = e.id
   where public.compose_jerusalem(d.occ_start_date, e.start_time) <= p_to
     and public.compose_jerusalem(
           d.occ_start_date + (e.end_date - e.start_date), e.end_time
         ) >= p_from
   order by occurrence_start, e.title;
$$;

-- ============================================================================
-- AUDIENCE RESOLUTION — canonical answers to:
--   A. does this event apply to student X?
--   B. does this event apply to staff member X?
-- ============================================================================
create or replace function public.calendar_event_applies_to_student(
  p_event_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.calendar_event_audiences a
      join public.students s on s.id = p_student_id
     where a.event_id = p_event_id
       and (
         a.audience_type = 'everyone'
         or (a.audience_type = 'home_group'
             and a.greenhouse_group_id = s.group_id)
         or (a.audience_type = 'major' and a.major_id = s.major_id)
         or (a.audience_type = 'learning_group'
             and exists (
               select 1 from public.learning_group_memberships m
                where m.student_id = s.id
                  and m.learning_group_id = a.learning_group_id
                  and m.ended_at is null
             ))
       )
  );
$$;

create or replace function public.calendar_event_applies_to_staff(
  p_event_id uuid,
  p_staff_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.calendar_event_audiences a
     where a.event_id = p_event_id
       and (
         a.audience_type in ('everyone', 'staff_only')
         or (a.audience_type = 'staff_member' and a.staff_id = p_staff_id)
         or (a.audience_type = 'home_group'
             and exists (
               select 1 from public.group_mentors gm
                where gm.staff_id = p_staff_id
                  and gm.group_id = a.greenhouse_group_id
             ))
         or (a.audience_type = 'major'
             and exists (
               select 1 from public.major_heads mh
                where mh.staff_id = p_staff_id
                  and mh.major_id = a.major_id
             ))
         or (a.audience_type = 'learning_group'
             and exists (
               select 1 from public.learning_group_staff_leaders l
                where l.staff_id = p_staff_id
                  and l.learning_group_id = a.learning_group_id
             ))
       )
  );
$$;

-- ============================================================================
-- MANAGEMENT RPC (leadership / super_admin; authorization + audit inside)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create/edit a calendar event.
-- p_audiences jsonb: [{type:'everyone'|'staff_only'|'home_group'|'major'|
--   'learning_group'|'staff_member', greenhouse_group_id?, major_id?,
--   learning_group_id?, staff_id?}]
-- All-day events are normalized to 00:00–23:59 wall times.
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_calendar_event(
  p_id uuid,
  p_title text,
  p_description text,
  p_start_date date,
  p_start_time time,
  p_end_date date,
  p_end_time time,
  p_is_all_day boolean,
  p_recurrence text,
  p_recurrence_until date,
  p_audiences jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff  uuid := public.current_staff_id();
  v_title  text := btrim(coalesce(p_title, ''));
  v_desc   text := nullif(btrim(coalesce(p_description, '')), '');
  v_eid    uuid := p_id;
  v_created boolean := false;
  v_start_date date := p_start_date;
  v_start_time time := p_start_time;
  v_end_date date := p_end_date;
  v_end_time time := p_end_time;
  v_recurrence text := coalesce(p_recurrence, 'none');
  v_until date := p_recurrence_until;
  v_elem jsonb;
  v_type text;
  v_gref uuid; v_mref uuid; v_lref uuid; v_sref uuid;
  i int; n int;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not (
    public.staff_has_role(v_staff, 'leadership')
    or public.staff_has_role(v_staff, 'super_admin')
  ) then
    raise exception 'Only leadership or super_admin can manage calendar events'
      using errcode = '42501';
  end if;

  if v_title = '' or length(v_title) > 200 then
    raise exception 'כותרת האירוע נדרשת (עד 200 תווים)' using errcode = '23514';
  end if;
  if v_start_date is null or v_end_date is null then
    raise exception 'תאריכים נדרשים' using errcode = '23514';
  end if;

  -- all-day normalization: the full day(s), independent of submitted times
  if coalesce(p_is_all_day, false) then
    v_start_time := '00:00'::time;
    v_end_time := '23:59'::time;
  else
    if v_start_time is null or v_end_time is null then
      raise exception 'שעות התחלה וסיום נדרשות' using errcode = '23514';
    end if;
  end if;

  if not (v_end_date > v_start_date
          or (v_end_date = v_start_date and v_end_time > v_start_time)) then
    raise exception 'סוף האירוע חייב להיות אחרי התחלתו' using errcode = '23514';
  end if;

  if v_recurrence not in ('none', 'weekly', 'monthly') then
    raise exception 'סוג חזרה לא תקין' using errcode = '23514';
  end if;
  if v_recurrence <> 'none' then
    if v_until is null then
      raise exception 'אירוע חוזר דורש תאריך סיום' using errcode = '23514';
    end if;
    if v_until < v_start_date then
      raise exception 'תאריך הסיום של החזרה חייב להיות מהתאריך הראשון ואילך'
        using errcode = '23514';
    end if;
    if v_until > v_start_date + 730 then
      raise exception 'תאריך הסיום של החזרה מוגבל לשנתיים' using errcode = '23514';
    end if;
  else
    v_until := null;
  end if;

  -- ---- audiences ----
  if p_audiences is null or jsonb_typeof(p_audiences) <> 'array'
     or jsonb_array_length(p_audiences) = 0 then
    raise exception 'נדרש לפחות קהל יעד אחד' using errcode = '23514';
  end if;
  if jsonb_array_length(p_audiences) > 200 then
    raise exception 'יותר מדי קהלי יעד' using errcode = '23514';
  end if;
  n := jsonb_array_length(p_audiences);
  for i in 0 .. n - 1 loop
    v_elem := p_audiences -> i;
    v_type := v_elem ->> 'type';
    v_gref := nullif(v_elem ->> 'greenhouse_group_id', '')::uuid;
    v_mref := nullif(v_elem ->> 'major_id', '')::uuid;
    v_lref := nullif(v_elem ->> 'learning_group_id', '')::uuid;
    v_sref := nullif(v_elem ->> 'staff_id', '')::uuid;
    if v_type not in ('everyone', 'staff_only', 'home_group', 'major',
                      'learning_group', 'staff_member') then
      raise exception 'קהל יעד לא תקין' using errcode = '23514';
    end if;
    if v_type = 'home_group' and (v_gref is null or not exists (
         select 1 from public.greenhouse_groups g where g.id = v_gref)) then
      raise exception 'קבוצת אם לא תקינה' using errcode = '23514';
    end if;
    if v_type = 'major' and (v_mref is null or not exists (
         select 1 from public.majors m where m.id = v_mref)) then
      raise exception 'מגמה לא תקינה' using errcode = '23514';
    end if;
    if v_type = 'learning_group' and (v_lref is null or not exists (
         select 1 from public.learning_groups g where g.id = v_lref)) then
      raise exception 'קבוצת למידה לא תקינה' using errcode = '23514';
    end if;
    if v_type = 'staff_member' and (v_sref is null or not exists (
         select 1 from public.profiles p where p.id = v_sref and p.is_active)) then
      raise exception 'איש צוות לא תקין' using errcode = '23514';
    end if;
  end loop;

  -- ---- upsert ----
  if v_eid is null then
    insert into public.calendar_events
      (title, description, start_date, start_time, end_date, end_time,
       is_all_day, recurrence, recurrence_until, created_by_staff_id)
    values
      (v_title, v_desc, v_start_date, v_start_time, v_end_date, v_end_time,
       coalesce(p_is_all_day, false), v_recurrence, v_until, v_staff)
    returning id into v_eid;
    v_created := true;
  else
    update public.calendar_events
       set title = v_title,
           description = v_desc,
           start_date = v_start_date,
           start_time = v_start_time,
           end_date = v_end_date,
           end_time = v_end_time,
           is_all_day = coalesce(p_is_all_day, false),
           recurrence = v_recurrence,
           recurrence_until = v_until,
           status = 'active',
           deleted_at = null
     where id = v_eid;
    if not found then
      raise exception 'Calendar event not found';
    end if;
    delete from public.calendar_event_audiences where event_id = v_eid;
  end if;

  insert into public.calendar_event_audiences
    (event_id, audience_type, greenhouse_group_id, major_id, learning_group_id, staff_id)
  select v_eid,
         a ->> 'type',
         nullif(a ->> 'greenhouse_group_id', '')::uuid,
         nullif(a ->> 'major_id', '')::uuid,
         nullif(a ->> 'learning_group_id', '')::uuid,
         nullif(a ->> 'staff_id', '')::uuid
    from jsonb_array_elements(p_audiences) a;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff,
          case when v_created then 'calendar_event_created'
               else 'calendar_event_updated' end,
          'calendar_event', v_eid,
          jsonb_build_object('title', v_title, 'recurrence', v_recurrence,
                             'audiences', n));

  return jsonb_build_object('id', v_eid, 'created', v_created);
end;
$$;

-- soft delete (history preserved; audit written)
create or replace function public.admin_delete_calendar_event(p_event_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not (
    public.staff_has_role(v_staff, 'leadership')
    or public.staff_has_role(v_staff, 'super_admin')
  ) then
    raise exception 'Only leadership or super_admin can manage calendar events'
      using errcode = '42501';
  end if;

  update public.calendar_events
     set deleted_at = now()
   where id = p_event_id and deleted_at is null;
  if not found then
    raise exception 'Calendar event not found';
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'calendar_event_deleted', 'calendar_event', p_event_id, '{}');

  return true;
end;
$$;

-- cancel / restore (reversible, keeps history)
create or replace function public.admin_set_calendar_event_status(
  p_event_id uuid,
  p_status text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not (
    public.staff_has_role(v_staff, 'leadership')
    or public.staff_has_role(v_staff, 'super_admin')
  ) then
    raise exception 'Only leadership or super_admin can manage calendar events'
      using errcode = '42501';
  end if;
  if p_status not in ('active', 'cancelled') then
    raise exception 'סטטוס לא תקין' using errcode = '23514';
  end if;

  update public.calendar_events
     set status = p_status
   where id = p_event_id and deleted_at is null;
  if not found then
    raise exception 'Calendar event not found';
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'calendar_event_updated', 'calendar_event', p_event_id,
          jsonb_build_object('status', p_status));

  return true;
end;
$$;

-- ============================================================================
-- CANONICAL READ RPC: expanded occurrences (with audience labels) for a range.
-- Authenticated staff only; range capped at 400 days.
-- ============================================================================
create or replace function public.calendar_events_in_range(
  p_from date,
  p_to date
)
returns table (
  event_id         uuid,
  title            text,
  description      text,
  is_all_day       boolean,
  recurrence       text,
  occurrence_start timestamptz,
  occurrence_end   timestamptz,
  audience_labels  text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'טווח תאריכים לא תקין' using errcode = '22023';
  end if;

  return query
  select o.event_id, o.title, o.description, o.is_all_day, o.recurrence,
         o.occurrence_start, o.occurrence_end,
         coalesce((
           select array_agg(distinct lbl.label order by lbl.label)
             from public.calendar_event_audiences a
             left join public.greenhouse_groups g on g.id = a.greenhouse_group_id
             left join public.majors m on m.id = a.major_id
             left join public.learning_groups lg on lg.id = a.learning_group_id
             left join public.profiles p on p.id = a.staff_id
             left join lateral (
               select case a.audience_type
                 when 'everyone' then 'כולם'
                 when 'staff_only' then 'צוות בלבד'
                 when 'home_group' then 'קבוצת אם: ' || g.name
                 when 'major' then 'מגמה: ' || m.name
                 when 'learning_group' then 'קבוצת למידה: ' || lg.name
                 when 'staff_member' then 'צוות: ' || coalesce(p.full_name, '')
               end as label
             ) lbl on true
            where a.event_id = o.event_id
         ), '{}')
    from public.calendar_event_occurrences(
           public.compose_jerusalem(p_from, '00:00'),
           public.compose_jerusalem(p_to, '23:59')
         ) o;
end;
$$;

-- ============================================================================
-- UNIFIED SCHEDULE SERVICE — normalized read model (aggregation only; the
-- underlying tables are NOT merged). Employment can later be added as another
-- source without changing the shape.
--   source_type: 'calendar_event' | 'meeting' | 'learning_group'
-- ============================================================================

-- staff member's unified schedule for one Jerusalem calendar day
create or replace function public.staff_day_schedule(
  p_staff_id uuid,
  p_date date
)
returns table (
  source_type text,
  source_id   uuid,
  title       text,
  start_at    timestamptz,
  end_at      timestamptz,
  is_all_day  boolean,
  context     text,
  link_path   text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  -- 1. calendar events relevant to this staff member (audience-resolved)
  select 'calendar_event'::text, o.event_id, o.title,
         o.occurrence_start, o.occurrence_end, o.is_all_day,
         coalesce((select string_agg(distinct lbl.label, ' · ')
                     from public.calendar_event_audiences a
                     left join public.greenhouse_groups g on g.id = a.greenhouse_group_id
                     left join public.majors m on m.id = a.major_id
                     left join public.learning_groups lg on lg.id = a.learning_group_id
                     left join public.profiles p on p.id = a.staff_id
                     left join lateral (
                       select case a.audience_type
                         when 'everyone' then 'כולם'
                         when 'staff_only' then 'צוות בלבד'
                         when 'home_group' then 'קבוצת אם: ' || g.name
                         when 'major' then 'מגמה: ' || m.name
                         when 'learning_group' then 'קבוצת למידה: ' || lg.name
                         when 'staff_member' then 'צוות: ' || coalesce(p.full_name, '')
                       end as label
                     ) lbl on true
                    where a.event_id = o.event_id), '') as context,
         ('/calendar?date=' || to_char((o.occurrence_start at time zone 'Asia/Jerusalem')::date, 'YYYY-MM-DD'))::text
           as link_path
    from public.calendar_event_occurrences(
           public.compose_jerusalem(p_date, '00:00'),
           public.compose_jerusalem(p_date, '23:59')
         ) o
   where public.calendar_event_applies_to_staff(o.event_id, p_staff_id)

  union all

  -- 2. scheduled student meetings (mentor/master) — 60-minute assumed window
  select 'meeting'::text, o.id,
         ('פגישת ' || (case s.context when 'mentor' then 'מנטור' else 'מאסטר' end)
           || ' · ' || coalesce(st.full_name, ''))::text,
         o.due_at,
         o.due_at + interval '60 minutes',
         false,
         ('חניך/ה: ' || stu.first_name || ' ' || stu.last_name)::text,
         ('/students/' || s.student_id)::text
    from public.meeting_occurrences o
    join public.meeting_schedules s on s.id = o.schedule_id
    join public.profiles st on st.id = s.staff_id
    join public.students stu on stu.id = s.student_id
   where s.staff_id = p_staff_id
     and s.is_active
     and (o.due_at at time zone 'Asia/Jerusalem')::date = p_date

  union all

  -- 3. learning groups they lead (weekly slots on this weekday)
  select 'learning_group'::text, g.id,
         ('קבוצת למידה · ' || g.name)::text,
         public.compose_jerusalem(p_date, sl.start_time),
         public.compose_jerusalem(p_date, sl.end_time),
         false,
         'הובלת קבוצת למידה'::text,
         ('/groups/learning/' || g.id)::text
    from public.learning_group_weekly_slots sl
    join public.learning_groups g on g.id = sl.learning_group_id
   where sl.weekday = extract(dow from p_date)::smallint
     and g.is_active
     and exists (
       select 1 from public.learning_group_staff_leaders l
        where l.learning_group_id = g.id and l.staff_id = p_staff_id
     );
end;
$$;

-- student's unified schedule for one Jerusalem calendar day
create or replace function public.student_day_schedule(
  p_student_id uuid,
  p_date date
)
returns table (
  source_type text,
  source_id   uuid,
  title       text,
  start_at    timestamptz,
  end_at      timestamptz,
  is_all_day  boolean,
  context     text,
  link_path   text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  -- 1. calendar events relevant to this student (audience-resolved)
  select 'calendar_event'::text, o.event_id, o.title,
         o.occurrence_start, o.occurrence_end, o.is_all_day,
         coalesce((select string_agg(distinct lbl.label, ' · ')
                     from public.calendar_event_audiences a
                     left join public.greenhouse_groups g on g.id = a.greenhouse_group_id
                     left join public.majors m on m.id = a.major_id
                     left join public.learning_groups lg on lg.id = a.learning_group_id
                     left join public.profiles p on p.id = a.staff_id
                     left join lateral (
                       select case a.audience_type
                         when 'everyone' then 'כולם'
                         when 'staff_only' then 'צוות בלבד'
                         when 'home_group' then 'קבוצת אם: ' || g.name
                         when 'major' then 'מגמה: ' || m.name
                         when 'learning_group' then 'קבוצת למידה: ' || lg.name
                         when 'staff_member' then 'צוות: ' || coalesce(p.full_name, '')
                       end as label
                     ) lbl on true
                    where a.event_id = o.event_id), '') as context,
         ('/calendar?date=' || to_char((o.occurrence_start at time zone 'Asia/Jerusalem')::date, 'YYYY-MM-DD'))::text
           as link_path
    from public.calendar_event_occurrences(
           public.compose_jerusalem(p_date, '00:00'),
           public.compose_jerusalem(p_date, '23:59')
         ) o
   where public.calendar_event_applies_to_student(o.event_id, p_student_id)

  union all

  -- 2. their mentor/master meetings — 60-minute assumed window
  select 'meeting'::text, o.id,
         ('פגישת ' || (case s.context when 'mentor' then 'מנטור' else 'מאסטר' end)
           || ' · ' || coalesce(st.full_name, ''))::text,
         o.due_at,
         o.due_at + interval '60 minutes',
         false,
         ('מדריך/ה: ' || coalesce(st.full_name, ''))::text,
         ('/students/' || s.student_id)::text
    from public.meeting_occurrences o
    join public.meeting_schedules s on s.id = o.schedule_id
    join public.profiles st on st.id = s.staff_id
   where s.student_id = p_student_id
     and s.is_active
     and (o.due_at at time zone 'Asia/Jerusalem')::date = p_date

  union all

  -- 3. learning groups with an active membership
  select 'learning_group'::text, g.id,
         ('קבוצת למידה · ' || g.name)::text,
         public.compose_jerusalem(p_date, sl.start_time),
         public.compose_jerusalem(p_date, sl.end_time),
         false,
         'קבוצת למידה'::text,
         ('/groups/learning/' || g.id)::text
    from public.learning_group_weekly_slots sl
    join public.learning_groups g on g.id = sl.learning_group_id
   where sl.weekday = extract(dow from p_date)::smallint
     and exists (
       select 1 from public.learning_group_memberships m
        where m.learning_group_id = g.id
          and m.student_id = p_student_id
          and m.ended_at is null
     );
end;
$$;

-- ============================================================================
-- MEETING CONFLICT CHECK — server-backed (never browser-only).
-- For each candidate Jerusalem date + meeting wall-time window
-- [start, start + duration) find conflicts in the student's canonical
-- schedule: calendar events applying to the student, learning-group weekly
-- slots of active memberships, and the student's own scheduled meetings.
-- Touching boundaries are NOT conflicts (weekly_slots_overlap semantics).
-- ============================================================================
create or replace function public.check_student_meeting_conflicts(
  p_student_id uuid,
  p_dates date[],
  p_start_time time,
  p_duration_minutes int default 60,
  p_exclude_occurrence_id uuid default null
)
returns table (
  conflict_date date,
  source_type   text,
  source_id     uuid,
  title         text,
  start_at      timestamptz,
  end_at        timestamptz,
  description   text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_duration interval := make_interval(mins => coalesce(greatest(p_duration_minutes, 1), 60));
  d date;
  v_start timestamptz;
  v_end timestamptz;
  v_wd smallint;
begin
  if p_student_id is null or p_dates is null or p_start_time is null then
    return;
  end if;

  foreach d in array p_dates loop
    v_start := public.compose_jerusalem(d, p_start_time);
    v_end := v_start + v_duration;
    v_wd := extract(dow from d)::smallint;

    return query
    -- calendar events applying to the student
    select d, 'calendar_event'::text, o.event_id, o.title,
           o.occurrence_start, o.occurrence_end,
           format('האירוע "%s" (%s–%s)', o.title,
                  to_char((o.occurrence_start at time zone 'Asia/Jerusalem')::time, 'HH24:MI'),
                  to_char((o.occurrence_end at time zone 'Asia/Jerusalem')::time, 'HH24:MI'))
      from public.calendar_event_occurrences(v_start - interval '1 day', v_end + interval '1 day') o
     where public.calendar_event_applies_to_student(o.event_id, p_student_id)
       and o.occurrence_start < v_end
       and o.occurrence_end > v_start
    union all
    -- learning groups with an active membership (wall-clock overlap)
    select d, 'learning_group'::text, g.id, g.name,
           public.compose_jerusalem(d, sl.start_time),
           public.compose_jerusalem(d, sl.end_time),
           format('קבוצת הלמידה "%s" (%s–%s)', g.name,
                  to_char(sl.start_time, 'HH24:MI'), to_char(sl.end_time, 'HH24:MI'))
      from public.learning_group_weekly_slots sl
      join public.learning_groups g on g.id = sl.learning_group_id
     where sl.weekday = v_wd
       and sl.start_time < (p_start_time + v_duration)::time
       and p_start_time < sl.end_time
       and exists (
         select 1 from public.learning_group_memberships m
          where m.learning_group_id = g.id
            and m.student_id = p_student_id
            and m.ended_at is null
       )
    union all
    -- the student's own scheduled meetings (both contexts)
    select d, 'meeting'::text, o.id,
           ('פגישת ' || (case s.context when 'mentor' then 'מנטור' else 'מאסטר' end))::text,
           o.due_at, o.due_at + interval '60 minutes',
           format('פגישת %s קבועה (%s)',
                  case s.context when 'mentor' then 'מנטור' else 'מאסטר' end,
                  to_char((o.due_at at time zone 'Asia/Jerusalem')::time, 'HH24:MI'))
      from public.meeting_occurrences o
      join public.meeting_schedules s on s.id = o.schedule_id
     where s.student_id = p_student_id
       and s.is_active
       and o.id is distinct from p_exclude_occurrence_id
       and (o.due_at at time zone 'Asia/Jerusalem')::date = d
       and o.due_at < v_end
       and o.due_at + interval '60 minutes' > v_start;
  end loop;
end;
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.calendar_events          enable row level security;
alter table public.calendar_event_audiences enable row level security;

-- staff read model: any authorized staff may read the internal calendar;
-- relevance filtering happens in the schedule RPCs (audience resolution).
create policy "calendar_events_select_staff" on public.calendar_events
  for select to authenticated using (public.is_authorized_staff());

create policy "calendar_audiences_select_staff" on public.calendar_event_audiences
  for select to authenticated using (public.is_authorized_staff());

-- NO insert/update/delete policies: mutations run exclusively through the
-- management RPCs (leadership/super_admin checks inside).

-- ============================================================================
-- Grants
-- ============================================================================
grant select on public.calendar_events, public.calendar_event_audiences to authenticated;
grant all on public.calendar_events, public.calendar_event_audiences to service_role;

revoke all on function public.compose_jerusalem(date, time) from public, anon;
revoke all on function public.calendar_event_occurrences(timestamptz, timestamptz) from public, anon;
revoke all on function public.calendar_event_applies_to_student(uuid, uuid) from public, anon;
revoke all on function public.calendar_event_applies_to_staff(uuid, uuid) from public, anon;
revoke all on function public.admin_upsert_calendar_event(uuid, text, text, date, time, date, time, boolean, text, date, jsonb) from public, anon;
revoke all on function public.admin_delete_calendar_event(uuid) from public, anon;
revoke all on function public.admin_set_calendar_event_status(uuid, text) from public, anon;
revoke all on function public.calendar_events_in_range(date, date) from public, anon;
revoke all on function public.staff_day_schedule(uuid, date) from public, anon;
revoke all on function public.student_day_schedule(uuid, date) from public, anon;
revoke all on function public.check_student_meeting_conflicts(uuid, date[], time, int, uuid) from public, anon;

grant execute on function public.compose_jerusalem(date, time) to authenticated, service_role;
grant execute on function public.calendar_event_occurrences(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.calendar_event_applies_to_student(uuid, uuid) to authenticated, service_role;
grant execute on function public.calendar_event_applies_to_staff(uuid, uuid) to authenticated, service_role;
grant execute on function public.admin_upsert_calendar_event(uuid, text, text, date, time, date, time, boolean, text, date, jsonb) to authenticated;
grant execute on function public.admin_delete_calendar_event(uuid) to authenticated;
grant execute on function public.admin_set_calendar_event_status(uuid, text) to authenticated;
grant execute on function public.calendar_events_in_range(date, date) to authenticated;
grant execute on function public.staff_day_schedule(uuid, date) to authenticated;
grant execute on function public.student_day_schedule(uuid, date) to authenticated;
grant execute on function public.check_student_meeting_conflicts(uuid, date[], time, int, uuid) to authenticated;
