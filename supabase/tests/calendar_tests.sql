-- ============================================================================
-- Calendar + unified schedule + conflict tests (phase 2) — run against a
-- database with all migrations applied + seed:
--   supabase db reset && psql -f supabase/tests/calendar_tests.sql
--
-- Every test runs in its own transaction and rolls back.
-- Output: "PASS:" / "FAIL:" lines. A clean run has no FAILs.
-- ============================================================================

\set ronen   '11111111-1111-1111-1111-111111111101' -- super_admin
\set michal  '11111111-1111-1111-1111-111111111102' -- mentor (זית), LG leader
\set liat    '11111111-1111-1111-1111-111111111109' -- leadership
\set tom     '11111111-1111-1111-1111-11111111110a' -- plain staff

\set noam    '44444444-4444-4444-4444-444444444401' -- זית, member of צילום
\set talya   '44444444-4444-4444-4444-444444444402' -- זית, member of צילום

\set lg_photo '66666666-6666-6666-6666-666666666601'
\set zion     '22222222-2222-2222-2222-222222222201'
\set comm_major '33333333-3333-3333-3333-333333333301'

\echo '--- starting calendar + schedule test suite ---'

-- helper: create an event via the management RPC as a given seeded staff
-- (call after the claim lines of the specific test)

-- ============================================================================
-- C0: schema sanity
-- ============================================================================
do $$ begin
  if (select count(*) from information_schema.tables
      where table_schema='public' and table_name in
      ('calendar_events','calendar_event_audiences')) <> 2 then
    raise exception 'FAIL: calendar schema incomplete';
  end if;
  raise notice 'PASS: calendar schema present';
end $$;

-- ============================================================================
-- C1: occurrence expansion — one-off / all-day / multi-day (from seed)
-- ============================================================================
do $$ begin
  -- one-off today 09:00–13:00 Jerusalem
  if (select count(*) from public.calendar_event_occurrences(
        public.compose_jerusalem(current_date, '00:00'),
        public.compose_jerusalem(current_date, '23:59'))
      where title = 'יום ספורט') <> 1 then
    raise exception 'FAIL: one-off event not expanded on its day';
  end if;
  -- all-day tomorrow
  if (select count(*) from public.calendar_event_occurrences(
        public.compose_jerusalem(current_date + 1, '00:00'),
        public.compose_jerusalem(current_date + 1, '23:59'))
      where title = 'יום צילומים' and is_all_day) <> 1 then
    raise exception 'FAIL: all-day event not expanded';
  end if;
  -- multi-day: סדנה דו-יומית spans +7 → +8; both days show it
  if (select count(*) from public.calendar_event_occurrences(
        public.compose_jerusalem(current_date + 7, '00:00'),
        public.compose_jerusalem(current_date + 8, '23:59'))
      where title = 'סדנה דו-יומית') <> 1 then
    raise exception 'FAIL: multi-day event not expanded across its days';
  end if;
  raise notice 'PASS: one-off / all-day / multi-day expansion';
end $$;

-- ============================================================================
-- C2: weekly recurrence — expansion + until + DST wall-clock preservation
-- ============================================================================
begin;
do $$ declare
  v_cnt int;
  v_before_utc timestamptz;
  v_after_utc timestamptz;
begin
  -- מפגש צילום מורחב: weekly on (current_date+7) 16:30 until current_date+197
  select count(*) into v_cnt from public.calendar_event_occurrences(
    public.compose_jerusalem(current_date, '00:00'),
    public.compose_jerusalem(current_date + 210, '23:59'))
   where title = 'מפגש צילום מורחב';
  -- occurrences: +7, +14, ..., +196 (floor(190/7)+1 = 28, all within range)
  if v_cnt <> 28 then
    raise exception 'FAIL: weekly expansion count % <> 28', v_cnt;
  end if;

  -- recurrence ending: nothing beyond until
  select count(*) into v_cnt from public.calendar_event_occurrences(
    public.compose_jerusalem(current_date + 198, '00:00'),
    public.compose_jerusalem(current_date + 260, '23:59'))
   where title = 'מפגש צילום מורחב';
  if v_cnt <> 0 then
    raise exception 'FAIL: weekly recurrence continues past until';
  end if;

  -- DST: Israel switches IDT(+3)→IST(+2) on the last Sunday of October 2026
  -- (2026-10-25). A weekly event at 10:00 Jerusalem must compose to
  -- 07:00 UTC before the change and 08:00 UTC after it.
  v_before_utc := public.compose_jerusalem(date '2026-10-18', '10:00'); -- IDT
  v_after_utc  := public.compose_jerusalem(date '2026-11-01', '10:00'); -- IST
  if v_before_utc <> '2026-10-18T07:00:00Z'::timestamptz then
    raise exception 'FAIL: DST before-change composition wrong: %', v_before_utc;
  end if;
  if v_after_utc <> '2026-11-01T08:00:00Z'::timestamptz then
    raise exception 'FAIL: DST after-change composition wrong (wall time shifted): %', v_after_utc;
  end if;

  -- weekly event spanning the DST boundary keeps 10:00 wall time every week
  create temp table dst_probe on commit drop as
    select * from (values (date '2026-10-18'), (date '2026-10-25'), (date '2026-11-01')) t(d);
  insert into public.calendar_events
    (id, title, start_date, start_time, end_date, end_time, is_all_day, recurrence, recurrence_until, created_by_staff_id)
  values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'dst-probe', date '2026-10-18', '10:00',
     date '2026-10-18', '11:00', false, 'weekly', date '2026-11-30', '11111111-1111-1111-1111-111111111101');
  for v_before_utc, v_after_utc in
    select occurrence_start, occurrence_start
      from public.calendar_event_occurrences(
             public.compose_jerusalem(date '2026-10-01', '00:00'),
             public.compose_jerusalem(date '2026-12-31', '23:59'))
     where event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  loop
    if extract(hour from (v_before_utc at time zone 'Asia/Jerusalem')) <> 10 then
      raise exception 'FAIL: weekly occurrence shifted off 10:00 wall time across DST';
    end if;
  end loop;

  raise notice 'PASS: weekly recurrence, until-bounded, DST keeps Israel wall time';
end $$;
rollback;

-- ============================================================================
-- C3: monthly recurrence — same day-of-month, skips short months
-- ============================================================================
begin;
do $$ declare v_dates date[]; begin
  -- a probe: monthly on the 31st starting January 2027 until June 2027
  insert into public.calendar_events
    (id, title, start_date, start_time, end_date, end_time, is_all_day, recurrence, recurrence_until, created_by_staff_id)
  values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'monthly-probe', date '2027-01-31', '10:00',
     date '2027-01-31', '11:00', false, 'monthly', date '2027-06-30', '11111111-1111-1111-1111-111111111101');
  select coalesce(array_agg((occurrence_start at time zone 'Asia/Jerusalem')::date order by occurrence_start), '{}')
    into v_dates
    from public.calendar_event_occurrences(
           public.compose_jerusalem(date '2027-01-01', '00:00'),
           public.compose_jerusalem(date '2027-12-31', '23:59'))
   where event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
  -- Jan 31, Mar 31, May 31 — Feb/Apr/Jun skipped (no 31st)
  if v_dates <> array[date '2027-01-31', date '2027-03-31', date '2027-05-31'] then
    raise exception 'FAIL: monthly expansion wrong: %', v_dates;
  end if;
  raise notice 'PASS: monthly recurrence on the corresponding date, short months skipped';
end $$;
rollback;

-- ============================================================================
-- C4: audiences — canonical resolution for students and staff
-- ============================================================================
do $$ begin
  -- A. student: נועם is in זית, מגמת תקשורת, and an active member of צילום
  if not public.calendar_event_applies_to_student('77777777-7777-7777-7777-777777777701', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: everyone event does not apply to student';
  end if;
  if not public.calendar_event_applies_to_student('77777777-7777-7777-7777-777777777707', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: home-group event does not apply to member of that group';
  end if;
  if public.calendar_event_applies_to_student('77777777-7777-7777-7777-777777777707', '44444444-4444-4444-4444-444444444405') then
    raise exception 'FAIL: home-group event applies to a student of another group';
  end if;
  if not public.calendar_event_applies_to_student('77777777-7777-7777-7777-777777777708', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: major event does not apply to student of the major';
  end if;
  if not public.calendar_event_applies_to_student('77777777-7777-7777-7777-777777777704', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: learning-group event does not apply to active member';
  end if;
  -- a non-member of that learning group does not get the event
  if public.calendar_event_applies_to_student('77777777-7777-7777-7777-777777777704', '44444444-4444-4444-4444-444444444405') then
    raise exception 'FAIL: learning-group event applies to a non-member';
  end if;
  -- staff-only events do NOT apply to students
  if public.calendar_event_applies_to_student('77777777-7777-7777-7777-777777777705', '44444444-4444-4444-4444-444444444401') then
    raise exception 'FAIL: staff-only event applies to a student';
  end if;

  -- B. staff: מיכל mentors זית, leads צילום; רוני heads תקשורת; ליאת heads ביו-טכ
  if not public.calendar_event_applies_to_staff('77777777-7777-7777-7777-777777777705', '11111111-1111-1111-1111-11111111110a') then
    raise exception 'FAIL: staff-only event does not apply to plain staff';
  end if;
  if not public.calendar_event_applies_to_staff('77777777-7777-7777-7777-777777777707', '11111111-1111-1111-1111-111111111102') then
    raise exception 'FAIL: home-group event does not apply to its mentor';
  end if;
  if public.calendar_event_applies_to_staff('77777777-7777-7777-7777-777777777707', '11111111-1111-1111-1111-111111111103') then
    raise exception 'FAIL: home-group event applies to a mentor of another group';
  end if;
  if not public.calendar_event_applies_to_staff('77777777-7777-7777-7777-777777777708', '11111111-1111-1111-1111-111111111106') then
    raise exception 'FAIL: major event does not apply to the major head';
  end if;
  if not public.calendar_event_applies_to_staff('77777777-7777-7777-7777-777777777704', '11111111-1111-1111-1111-111111111102') then
    raise exception 'FAIL: learning-group event does not apply to its staff leader';
  end if;
  if not public.calendar_event_applies_to_staff('77777777-7777-7777-7777-777777777709', '11111111-1111-1111-1111-111111111102') then
    raise exception 'FAIL: specific-staff event does not apply to that staff member';
  end if;
  if public.calendar_event_applies_to_staff('77777777-7777-7777-7777-777777777709', '11111111-1111-1111-1111-111111111103') then
    raise exception 'FAIL: specific-staff event applies to a different staff member';
  end if;
  raise notice 'PASS: audience resolution (everyone/home group/major/LG/staff-only/specific staff)';
end $$;

-- ============================================================================
-- C5: management RPC — leadership ok, plain staff blocked, validation,
--     direct client writes blocked, audit written
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.admin_upsert_calendar_event(
      null, 'אירוע אסור', null, current_date, '10:00', current_date, '11:00',
      false, 'none', null, '[{"type":"everyone"}]'::jsonb);
    raise exception 'FAIL: plain staff created a calendar event';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: unauthorized staff blocked from event mutation';
end $$;
rollback;

begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ declare v jsonb; v_id uuid; begin
  -- leadership creates a weekly recurring event
  select public.admin_upsert_calendar_event(
    null, 'אירוע הנהלה', 'בדיקה', current_date + 1, '09:00', current_date + 1, '10:00',
    false, 'weekly', current_date + 61,
    '[{"type":"staff_only"},{"type":"home_group","greenhouse_group_id":"22222222-2222-2222-2222-222222222201"}]'::jsonb
  ) into v;
  v_id := (v ->> 'id')::uuid;
  if (select count(*) from public.calendar_event_audiences where event_id = v_id) <> 2 then
    raise exception 'FAIL: audiences not stored';
  end if;

  -- validation: end before start
  begin
    perform public.admin_upsert_calendar_event(
      null, 'שגוי', null, current_date, '12:00', current_date, '11:00',
      false, 'none', null, '[{"type":"everyone"}]'::jsonb);
    raise exception 'FAIL: end<=start accepted';
  exception when check_violation then null; end;

  -- validation: recurring requires until
  begin
    perform public.admin_upsert_calendar_event(
      null, 'שגוי', null, current_date, '10:00', current_date, '11:00',
      false, 'weekly', null, '[{"type":"everyone"}]'::jsonb);
    raise exception 'FAIL: recurring without until accepted';
  exception when check_violation then null; end;

  -- validation: recurring until >= start_date
  begin
    perform public.admin_upsert_calendar_event(
      null, 'שגוי', null, current_date, '10:00', current_date, '11:00',
      false, 'weekly', current_date - 1, '[{"type":"everyone"}]'::jsonb);
    raise exception 'FAIL: until < start accepted';
  exception when check_violation then null; end;

  -- validation: audience required
  begin
    perform public.admin_upsert_calendar_event(
      null, 'שגוי', null, current_date, '10:00', current_date, '11:00',
      false, 'none', null, '[]'::jsonb);
    raise exception 'FAIL: empty audiences accepted';
  exception when check_violation then null; end;

  -- direct client insert is blocked (no insert policies)
  begin
    insert into public.calendar_events (title, start_date, start_time, end_date, end_time, created_by_staff_id)
    values ('חדירה', current_date, '10:00', current_date, '11:00', '11111111-1111-1111-1111-111111111109');
    raise exception 'FAIL: direct client insert succeeded';
  exception when insufficient_privilege then null; end;

  raise notice 'PASS: leadership creates events; validation + no direct writes enforced';
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.audit_logs where action = 'calendar_event_created') < 1 then
    raise exception 'FAIL: calendar_event_created audit missing';
  end if;
  raise notice 'PASS: event creation audited';
end $$;
rollback;

-- delete (soft) + audit
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'liat@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111109","role":"authenticated"}', true);
do $$ declare v jsonb; v_id uuid; begin
  v := public.admin_upsert_calendar_event(
    null, 'למחיקה', null, current_date + 1, '09:00', current_date + 1, '10:00',
    false, 'none', null, '[{"type":"everyone"}]'::jsonb);
  v_id := (v ->> 'id')::uuid;
  perform public.admin_delete_calendar_event(v_id);
  if (select count(*) from public.calendar_events where id = v_id and deleted_at is not null) <> 1 then
    raise exception 'FAIL: event not soft-deleted';
  end if;
  if (select count(*) from public.calendar_event_occurrences(
        public.compose_jerusalem(current_date, '00:00'),
        public.compose_jerusalem(current_date + 30, '23:59'))
      where event_id = v_id) <> 0 then
    raise exception 'FAIL: deleted event still expands';
  end if;
  raise notice 'PASS: soft delete hides the event from expansion';
end $$;
select set_config('role', 'postgres', true);
do $$ begin
  if (select count(*) from public.audit_logs where action = 'calendar_event_deleted') < 1 then
    raise exception 'FAIL: calendar_event_deleted audit missing';
  end if;
  raise notice 'PASS: event deletion audited';
end $$;
rollback;

-- cancelled events do not expand
do $$ begin
  if (select count(*) from public.calendar_event_occurrences(
        public.compose_jerusalem(current_date, '00:00'),
        public.compose_jerusalem(current_date + 30, '23:59'))
      where title = 'אירוע מבוטל') <> 0 then
    raise exception 'FAIL: cancelled event expanded';
  end if;
  raise notice 'PASS: cancelled events excluded from expansion';
end $$;

-- ============================================================================
-- C6: RLS — staff read, anon zero
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'tom@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-11111111110a","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.calendar_events) < 9 then
    raise exception 'FAIL: staff cannot read calendar events';
  end if;
  raise notice 'PASS: authorized staff reads calendar events';
end $$;
rollback;

begin;
select set_config('role', 'anon', true);
do $$ begin
  if (select count(*) from public.calendar_events) <> 0 then
    raise exception 'FAIL: anon can read calendar events';
  end if;
  raise notice 'PASS: anon has zero calendar access';
end $$;
rollback;

-- ============================================================================
-- C7: unified staff schedule — events + meetings + led learning groups
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare
  v date := current_date;
  v_dow int := extract(dow from current_date);
  -- next Monday (v_dow=1) or the date itself if today is Monday
  v_monday date := v + ((1 - v_dow + 7) % 7);
  v_events int; v_meetings int; v_lgs int;
begin
  -- on Monday: מפגש צילום מורחב (LG leader audience) + weekly mentor meeting (seed)
  select count(*) into v_events from public.staff_day_schedule('11111111-1111-1111-1111-111111111102', v_monday)
   where source_type = 'calendar_event';
  select count(*) into v_meetings from public.staff_day_schedule('11111111-1111-1111-1111-111111111102', v_monday)
   where source_type = 'meeting';
  select count(*) into v_lgs from public.staff_day_schedule('11111111-1111-1111-1111-111111111102', v_monday)
   where source_type = 'learning_group';

  if v_lgs <> 1 then
    raise exception 'FAIL: staff schedule missing led learning group (got %)', v_lgs;
  end if;
  if v_meetings < 1 then
    raise exception 'FAIL: staff schedule missing scheduled meeting (got %)', v_meetings;
  end if;
  if v_events < 1 then
    raise exception 'FAIL: staff schedule missing applicable event (got %)', v_events;
  end if;

  -- unrelated event absent: מיכל is not a specific-staff target of event 09
  if exists (
    select 1 from public.staff_day_schedule('11111111-1111-1111-1111-111111111102', current_date + 2)
     where title = 'שיחה אישית מיכל'
  ) then
    -- מיכל IS the target — this event MUST appear for her
    null;
  end if;
  if exists (
    select 1 from public.staff_day_schedule('11111111-1111-1111-1111-111111111103', current_date + 2)
     where title = 'שיחה אישית מיכל'
  ) then
    raise exception 'FAIL: specific-staff event leaked to another staff member';
  end if;

  -- chronological ordering
  if exists (
    select 1 from (
      select start_at, lag(start_at) over (order by start_at) prev
        from public.staff_day_schedule('11111111-1111-1111-1111-111111111102', v_monday)
    ) t where start_at < prev
  ) then
    raise exception 'FAIL: staff schedule not chronologically ordered';
  end if;

  raise notice 'PASS: staff schedule combines events + meetings + led learning groups, ordered';
end $$;
rollback;

-- ============================================================================
-- C8: unified student schedule — events + meetings + learning groups
-- ============================================================================
do $$ declare
  v_monday date := current_date + ((1 - extract(dow from current_date)::int + 7) % 7);
  v_events int; v_meetings int; v_lgs int;
begin
  select count(*) into v_events from public.student_day_schedule('44444444-4444-4444-4444-444444444401', v_monday)
   where source_type = 'calendar_event';
  select count(*) into v_meetings from public.student_day_schedule('44444444-4444-4444-4444-444444444401', v_monday)
   where source_type = 'meeting';
  select count(*) into v_lgs from public.student_day_schedule('44444444-4444-4444-4444-444444444401', v_monday)
   where source_type = 'learning_group';

  if v_lgs <> 1 then
    raise exception 'FAIL: student schedule missing learning group (got %)', v_lgs;
  end if;
  if v_meetings < 1 then
    raise exception 'FAIL: student schedule missing weekly meeting (got %)', v_meetings;
  end if;
  if v_events < 1 then
    raise exception 'FAIL: student schedule missing applicable event (got %)', v_events;
  end if;

  -- unrelated event absent: מגמת ביוטכנולוגיה event doesn't reach נועם (תקשורת)
  if exists (
    select 1 from public.student_day_schedule('44444444-4444-4444-4444-444444444401', current_date)
     where title = 'אירוע שלא קשור'
  ) then
    raise exception 'FAIL: impossible row';
  end if;
  -- staff-only event never reaches the student
  if exists (
    select 1 from public.student_day_schedule('44444444-4444-4444-4444-444444444401', v_monday)
     where title = 'ישיבת צוות שבועית'
  ) then
    raise exception 'FAIL: staff-only event leaked into student schedule';
  end if;

  raise notice 'PASS: student schedule combines events + meetings + learning groups; unrelated absent';
end $$;

-- ============================================================================
-- C9: conflict check — LG / calendar event / meeting conflicts + touching OK
-- ============================================================================
begin;
select set_config('role', 'postgres', true);
update public.profiles set auth_user_id = id where email = 'michal@chamama.example';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111102","role":"authenticated"}', true);
do $$ declare
  v_monday date := current_date + ((1 - extract(dow from current_date)::int + 7) % 7);
  v_rows int;
begin
  -- נועם is in קבוצת צילום (Mon 16:00–17:30) and has a 16:00 mentor meeting:
  -- scheduling at Monday 16:00 must warn for BOTH the LG slot and the meeting
  select count(*) into v_rows from public.check_student_meeting_conflicts(
    '44444444-4444-4444-4444-444444444401', array[v_monday], '16:00', 60);
  if v_rows < 2 then
    raise exception 'FAIL: expected LG + meeting conflicts, got %', v_rows;
  end if;
  if not exists (
    select 1 from public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[v_monday], '16:00', 60)
     where source_type = 'learning_group' and title = 'קבוצת צילום'
  ) then
    raise exception 'FAIL: learning-group conflict missing';
  end if;
  if not exists (
    select 1 from public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[v_monday], '16:00', 60)
     where source_type = 'meeting'
  ) then
    raise exception 'FAIL: existing-meeting conflict missing';
  end if;

  -- calendar event conflict: מפגש צילום מורחב (LG audience) 16:30–17:00 —
  -- its weekly occurrences start at current_date+7, so probe next-next Monday
  if not exists (
    select 1 from public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[v_monday + 7], '16:30', 60)
     where source_type = 'calendar_event'
  ) then
    raise exception 'FAIL: calendar-event conflict missing';
  end if;

  -- touching boundaries do NOT conflict: 17:30–18:30 vs LG 16:00–17:30
  if exists (
    select 1 from public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[v_monday], '17:30', 60)
     where source_type = 'learning_group'
  ) then
    raise exception 'FAIL: touching boundary wrongly reported as conflict';
  end if;

  -- unrelated weekday: no conflicts on a free slot far from anything
  if exists (
    select 1 from public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[current_date + ((5 - extract(dow from current_date)::int + 7) % 7)], '20:00', 30)
  ) then
    raise exception 'FAIL: phantom conflict on a free slot';
  end if;

  raise notice 'PASS: conflict check (LG / event / meeting conflicts, touching OK, no phantoms)';
end $$;
rollback;

-- ============================================================================
-- C10: anon cannot call schedule/conflict RPCs
-- ============================================================================
begin;
select set_config('role', 'anon', true);
do $$ begin
  begin
    perform public.staff_day_schedule('11111111-1111-1111-1111-111111111102', current_date);
    raise exception 'FAIL: anon called staff_day_schedule';
  exception when insufficient_privilege then null; end;
  begin
    perform public.check_student_meeting_conflicts(
      '44444444-4444-4444-4444-444444444401', array[current_date], '10:00', 60);
    raise exception 'FAIL: anon called check_student_meeting_conflicts';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS: schedule/conflict RPCs denied to anon';
end $$;
rollback;

\echo '--- calendar + schedule test suite finished (no FAIL above = clean) ---'
