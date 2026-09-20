-- ============================================================================
-- Migration 20260921000003: READ-STATE FEED, INTAKE TOKENS, DASHBOARD MAJOR
--
-- Additive. Applied AFTER the deployed 20260921000002.
-- Nothing in this file modifies an already-deployed migration's file; the
-- functions replaced here keep their exact deployed shapes (value-level
-- fixes only), so CREATE OR REPLACE is legal for them.
--
-- 1. staff_message_updates(p_limit) — unified message list for /updates with
--    the CURRENT staff member's persisted read state (read + unread).
-- 2. intake_window_tokens — additional recoverable public tokens per intake
--    window (legacy window.token_hash keeps working unchanged). Encrypted
--    material lives here so a public link can always be re-copied WITHOUT
--    rotating/invalidating anything. No client policies (service-role only).
-- 3. intake_window_for_token — accepts the legacy window token AND any active
--    child token; soft-deleted windows stop resolving.
-- 4. dashboard_rows / dashboard_rows_view_as — project_major_name now falls
--    back to students.major_id (project major first, then the student's
--    static major), resolved to the major NAME. Same output shapes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. staff_message_updates — /updates feed with persisted per-user read state
--    (same visibility predicate as the deployed unread_messages)
-- ---------------------------------------------------------------------------
create or replace function public.staff_message_updates(p_limit int default 200)
returns table (
  message_id           uuid,
  student_id           uuid,
  student_first_name   text,
  student_last_name    text,
  author_staff_id      uuid,
  author_name          text,
  body                 text,
  created_at           timestamptz,
  is_general_visible   boolean,
  is_hidden_from_leads boolean,
  read                 boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select public.current_staff_id() as sid)
  select m.id, s.id, s.first_name, s.last_name,
         m.author_staff_id, p.full_name, m.body, m.created_at,
         m.is_general_visible, m.is_hidden_from_leads,
         exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         ) as read
    from public.student_messages m
    join public.students s on s.id = m.student_id
    join public.profiles p on p.id = m.author_staff_id
   cross join me
   where me.sid is not null
     and m.deleted_at is null
     and (
       public.staff_is_privileged(me.sid)
       or public.is_student_mentor(me.sid, m.student_id)
       or (
         not m.is_hidden_from_leads
         and (
           public.is_assigned_master(me.sid, m.student_id)
           or public.is_major_head_for_student(me.sid, m.student_id)
         )
       )
       or m.is_general_visible
     )
   order by m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

revoke all on function public.staff_message_updates(int) from public, anon;
grant execute on function public.staff_message_updates(int) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. intake_window_tokens — additional recoverable tokens (legacy-compatible)
-- ---------------------------------------------------------------------------
create table if not exists public.intake_window_tokens (
  id                uuid primary key default gen_random_uuid(),
  intake_window_id  uuid not null references public.intake_windows (id) on delete cascade,
  token_hash        text not null unique, -- sha256 hex; raw token never stored
  encrypted_token   text,                 -- AES-256-GCM ciphertext (hex), nullable
  encryption_iv     text,
  encryption_tag    text,
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz
);

create index if not exists idx_intake_window_tokens_window
  on public.intake_window_tokens (intake_window_id);

-- no plaintext tokens, no client access: written/read exclusively by
-- server-side, service-role actions (same model as audit_logs)
alter table public.intake_window_tokens enable row level security;
revoke all on public.intake_window_tokens from authenticated, anon;
grant all on public.intake_window_tokens to service_role;

-- ---------------------------------------------------------------------------
-- 3. intake_window_for_token — legacy window token OR active child token;
--    soft-deleted windows stop resolving. Same return shape (window row).
-- ---------------------------------------------------------------------------
create or replace function public.intake_window_for_token(p_token text)
returns public.intake_windows
language sql
stable
security definer
set search_path = public
as $$
  select w.*
    from public.intake_windows w
   where w.deleted_at is null
     and w.is_revoked = false
     and w.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
   union all
  select w.*
    from public.intake_window_tokens t
    join public.intake_windows w on w.id = t.intake_window_id
   where t.revoked_at is null
     and w.deleted_at is null
     and w.is_revoked = false
     and t.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 4. dashboard_rows — project major first, fallback to students.major_id
--    (body-only change; output shape identical to the deployed version)
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
         or exists (select 1 from public.student_projects sp
                     join public.major_heads mh on mh.major_id = sp.major_id
                    where sp.student_id = s.id and mh.staff_id = me.sid)
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
-- dashboard_rows_view_as — same major fallback (body-only change)
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
    or (p_context = 'major_head' and exists (select 1 from public.student_projects sp2 join public.major_heads mh on mh.major_id = sp2.major_id where sp2.student_id = s.id and mh.staff_id = p_target_staff_id))
    or (p_context = 'project_coordinator' and sp.id is not null)
    or (p_context = 'staff')
  )
  order by case la.status when 'red' then 0 when 'yellow' then 1 when 'green' then 2 else 3 end, s.first_name, s.last_name;
end;
$$;
