-- ============================================================================
-- Migration 20260923000007: MAJOR HEADS SEE THEIR MAJOR'S STUDENTS ON HOME
--
-- Additive. Applied AFTER 20260923000006. No deployed migration file is
-- modified; replaced functions keep their exact deployed signatures and
-- output shapes (CREATE OR REPLACE, body-only changes).
--
-- Canonical relationship (unchanged, already used by message visibility and
-- by dashboard_rows.in_my_majors): public.is_major_head_for_student() —
--   major_heads -> major -> students of that major, where a student's major
--   is the project major when a project exists, otherwise students.major_id.
--
-- 1. dashboard_rows() — the major-head SCOPE branch matched only
--    student_projects.major_id, so a (non-privileged) major head got NO row
--    for a student whose major comes from students.major_id (no project).
--    It now uses the canonical function — the same predicate the function's
--    own in_my_majors column and message RLS already use. Not a broadening
--    beyond the existing canonical authorization.
-- 2. dashboard_rows_view_as() — same fix for the simulated major_head context.
-- 3. home_major_student_ids() — NEW read-only RPC: the CALLER's own major
--    students (union over every major they head, distinct). Keyed on
--    current_staff_id() only: roles (leadership / super_admin) grant nothing
--    here, and View-As never uses it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. dashboard_rows — canonical major-head scope
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_rows()
returns table (
  student_id           uuid,
  student_name         text,
  group_name           text,
  has_project          boolean,
  project_major_name   text,
  intent_text          text,
  primary_master_name  text,
  master_names         text,
  status               text,
  status_source        text,
  last_report_at       timestamptz,
  intervention         boolean,
  mentor_last_meeting_at timestamptz,
  mentor_last_status   text,
  master_last_meeting_at timestamptz,
  master_last_status   text,
  mentor_next_meeting_at timestamptz,
  mentor_next_meeting_weekday smallint,
  mentor_next_meeting_time time,
  master_next_meeting_at timestamptz,
  master_next_meeting_weekday smallint,
  master_next_meeting_time time,
  in_my_groups         boolean,
  master_assigned      boolean,
  in_my_majors         boolean,
  broad_viewer         boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select public.current_staff_id() as sid,
           (public.staff_is_privileged(public.current_staff_id())
            or public.staff_has_role(public.current_staff_id(), 'super_admin')) as broad
  ),
  scope as (
    select s.id
      from public.students s, me
     where not s.is_archived
       and (
         me.broad
         or exists (select 1 from public.group_mentors gm
                     where gm.staff_id = me.sid and gm.group_id = s.group_id)
         or exists (select 1 from public.master_assignments ma
                     where ma.staff_id = me.sid and ma.student_id = s.id)
         or public.is_major_head_for_student(me.sid, s.id)
       )
  ),
  latest_any as (
    select distinct on (r.student_id)
           r.student_id, r.status, r.intervention, r.meeting_at, r.context
      from public.meeting_reports r
     where r.deleted_at is null
     order by r.student_id, r.created_at desc, r.meeting_at desc
  ),
  latest_mentor as (
    select distinct on (r.student_id)
           r.student_id, r.meeting_at, r.status, r.intervention
      from public.meeting_reports r
     where r.deleted_at is null and r.context = 'mentor'
     order by r.student_id, r.created_at desc, r.meeting_at desc
  ),
  latest_master as (
    select distinct on (r.student_id)
           r.student_id, r.meeting_at, r.status, r.intervention
      from public.meeting_reports r
     where r.deleted_at is null and r.context = 'master'
     order by r.student_id, r.created_at desc, r.meeting_at desc
  ),
  next_meetings as (
    select s2.student_id, s2.context, min(o.due_at) as next_at
      from public.meeting_occurrences o
      join public.meeting_schedules s2 on s2.id = o.schedule_id
     where s2.is_active
       and o.due_at >= now() - interval '30 minutes'
     group by s2.student_id, s2.context
  ),
  next_detail as (
    select distinct on (s2.student_id, s2.context)
           s2.student_id, s2.context, o.due_at, s2.weekday, s2.meeting_time
      from public.meeting_occurrences o
      join public.meeting_schedules s2 on s2.id = o.schedule_id
     where s2.is_active
       and o.due_at >= now() - interval '30 minutes'
     order by s2.student_id, s2.context, o.due_at asc
  )
  select s.id,
         s.first_name || ' ' || s.last_name,
         g.name,
         (sp.id is not null),
         m.name,
         sp.intent_text,
         (select p2.full_name
            from public.master_assignments ma
            join public.profiles p2 on p2.id = ma.staff_id
           where ma.student_id = s.id and ma.is_primary),
         (select string_agg(p2.full_name, ', ' order by p2.full_name)
            from public.master_assignments ma
            join public.profiles p2 on p2.id = ma.staff_id
           where ma.student_id = s.id),
         la.status,
         la.context,
         la.meeting_at,
         la.intervention,
         lm.meeting_at,
         lm.status,
         lmas.meeting_at,
         lmas.status,
         nmn.next_at,
         nmn2.weekday,
         nmn2.meeting_time,
         nms.next_at,
         nms2.weekday,
         nms2.meeting_time,
         (me.broad or exists (
            select 1 from public.group_mentors gm
             where gm.staff_id = me.sid and gm.group_id = s.group_id)),
         (me.broad or exists (
            select 1 from public.master_assignments ma
             where ma.staff_id = me.sid and ma.student_id = s.id)),
         (me.broad or public.is_major_head_for_student(me.sid, s.id)),
         me.broad
    from public.students s
    join scope on scope.id = s.id
    cross join me
    left join public.greenhouse_groups g on g.id = s.group_id
    left join public.student_projects sp on sp.student_id = s.id
    left join public.majors m on m.id = coalesce(sp.major_id, s.major_id)
    left join latest_any la on la.student_id = s.id
    left join latest_mentor lm on lm.student_id = s.id
    left join latest_master lmas on lmas.student_id = s.id
    left join (select student_id, context, next_at from next_meetings where context = 'mentor') nmn
      on nmn.student_id = s.id
    left join (select student_id, context, next_at from next_meetings where context = 'master') nms
      on nms.student_id = s.id
    left join next_detail nmn2 on nmn2.student_id = s.id and nmn2.context = 'mentor'
    left join next_detail nms2 on nms2.student_id = s.id and nms2.context = 'master'
   order by
     case la.status when 'red' then 0 when 'yellow' then 1 when 'green' then 2 else 3 end,
     s.first_name, s.last_name;
$$;

-- ---------------------------------------------------------------------------
-- 2. dashboard_rows_view_as — canonical major-head scope for the target
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_rows_view_as(
  p_target_staff_id uuid, p_context text
) returns table (
  student_id uuid, student_name text, group_name text,
  has_project boolean, project_major_name text, intent_text text,
  primary_master_name text, master_names text,
  status text, status_source text, last_report_at timestamptz,
  intervention boolean,
  mentor_last_meeting_at timestamptz, mentor_last_status text,
  master_last_meeting_at timestamptz, master_last_status text,
  mentor_next_meeting_at timestamptz, mentor_next_meeting_weekday smallint, mentor_next_meeting_time time,
  master_next_meeting_at timestamptz, master_next_meeting_weekday smallint, master_next_meeting_time time
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_has_role(public.current_staff_id(), 'super_admin')
     or not public.staff_is_authorized(p_target_staff_id) then return; end if;
  if p_context not in ('staff','mentor','master','major_head','project_coordinator') then return; end if;
  return query
  select s.id, s.first_name || ' ' || s.last_name, g.name,
    (sp.id is not null), m.name, sp.intent_text,
    (select p2.full_name from public.master_assignments ma join public.profiles p2 on p2.id = ma.staff_id where ma.student_id = s.id and ma.is_primary),
    (select string_agg(p2.full_name, ', ' order by p2.full_name) from public.master_assignments ma join public.profiles p2 on p2.id = ma.staff_id where ma.student_id = s.id),
    la.status, la.context, la.meeting_at, la.intervention,
    lm.meeting_at, lm.status, lmas.meeting_at, lmas.status,
    nmn.next_at, nmn2.weekday, nmn2.meeting_time,
    nms.next_at, nms2.weekday, nms2.meeting_time
  from public.students s
  left join public.greenhouse_groups g on g.id = s.group_id
  left join public.student_projects sp on sp.student_id = s.id
  left join public.majors m on m.id = coalesce(sp.major_id, s.major_id)
  left join lateral (select distinct on (r.student_id) r.student_id, r.status, r.intervention, r.meeting_at, r.context from public.meeting_reports r where r.student_id = s.id and r.deleted_at is null order by r.student_id, r.created_at desc) la on true
  left join lateral (select distinct on (r.student_id) r.student_id, r.meeting_at, r.status from public.meeting_reports r where r.student_id = s.id and r.deleted_at is null and r.context = 'mentor' order by r.student_id, r.created_at desc) lm on true
  left join lateral (select distinct on (r.student_id) r.student_id, r.meeting_at, r.status from public.meeting_reports r where r.student_id = s.id and r.deleted_at is null and r.context = 'master' order by r.student_id, r.created_at desc) lmas on true
  left join lateral (select min(o.due_at) as next_at from public.meeting_occurrences o join public.meeting_schedules s2 on s2.id = o.schedule_id where s2.student_id = s.id and s2.context = 'mentor' and s2.is_active and o.due_at >= now() - interval '30 minutes') nmn on true
  left join lateral (select distinct on (s2.context) o.due_at, s2.weekday, s2.meeting_time from public.meeting_occurrences o join public.meeting_schedules s2 on s2.id = o.schedule_id where s2.student_id = s.id and s2.context = 'mentor' and s2.is_active and o.due_at >= now() - interval '30 minutes' order by s2.context, o.due_at asc) nmn2 on true
  left join lateral (select min(o.due_at) as next_at from public.meeting_occurrences o join public.meeting_schedules s2 on s2.id = o.schedule_id where s2.student_id = s.id and s2.context = 'master' and s2.is_active and o.due_at >= now() - interval '30 minutes') nms on true
  left join lateral (select distinct on (s2.context) o.due_at, s2.weekday, s2.meeting_time from public.meeting_occurrences o join public.meeting_schedules s2 on s2.id = o.schedule_id where s2.student_id = s.id and s2.context = 'master' and s2.is_active and o.due_at >= now() - interval '30 minutes' order by s2.context, o.due_at asc) nms2 on true
  where not s.is_archived and (
    (p_context = 'mentor' and exists (select 1 from public.group_mentors gm where gm.staff_id = p_target_staff_id and gm.group_id = s.group_id))
    or (p_context = 'master' and exists (select 1 from public.master_assignments ma where ma.staff_id = p_target_staff_id and ma.student_id = s.id))
    or (p_context = 'major_head' and public.is_major_head_for_student(p_target_staff_id, s.id))
    or (p_context = 'project_coordinator' and sp.id is not null)
    or (p_context = 'staff')
  )
  order by case la.status when 'red' then 0 when 'yellow' then 1 when 'green' then 2 else 3 end, s.first_name, s.last_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. home_major_student_ids — the caller's major-head students (Home "מגמה")
-- ---------------------------------------------------------------------------
create or replace function public.home_major_student_ids()
returns table (student_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select public.current_staff_id() as sid)
  select s.id
    from public.students s
   cross join me
   where me.sid is not null
     and not s.is_archived
     and exists (select 1 from public.major_heads mh where mh.staff_id = me.sid)
     and public.is_major_head_for_student(me.sid, s.id)
   order by s.id;
$$;

revoke all on function public.home_major_student_ids() from public, anon;
grant execute on function public.home_major_student_ids() to authenticated;
