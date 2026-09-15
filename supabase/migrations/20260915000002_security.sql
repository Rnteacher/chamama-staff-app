-- ============================================================================
-- Migration 0002: permission helper functions, RLS enablement + policies,
-- function grants, realtime publication.
--
-- Permission precedence (deterministic):
--   1. counselor / project_coordinator / leadership   -> read everything
--   2. student's mentor                               -> read everything about
--                                                        their group
--   3. if is_hidden_from_leads: master + major_head (and general staff) denied
--   4. assigned master                                -> may read
--   5. relevant major head                            -> may read
--   6. message approved for general visibility        -> any authorized staff
--   7. otherwise                                      -> deny
--
-- super_admin intentionally does NOT bypass message privacy: it is a
-- technical administration role, not a content role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profile_is_authorized(p_user): profile exists, active, email on an active
-- allowlist entry. (belt & braces: profiles.is_active mirrors the allowlist)
-- ---------------------------------------------------------------------------
create or replace function public.profile_is_authorized(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
      join public.allowed_staff_emails a
        on a.email = p.email and a.is_active
     where p.id = p_user_id
       and p.is_active
  );
$$;

-- Current caller is an authorized staff member
create or replace function public.is_authorized_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.profile_is_authorized(auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
create or replace function public.user_has_role(
  p_role public.app_role,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur
     where ur.user_id = p_user_id and ur.role = p_role
  );
$$;

create or replace function public.is_super_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.user_has_role('super_admin', p_user_id);
$$;

-- Privileged global roles: read everything, restrictions never apply
create or replace function public.user_is_privileged(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur
     where ur.user_id = p_user_id
       and ur.role in ('counselor', 'project_coordinator', 'leadership')
  );
$$;

-- ---------------------------------------------------------------------------
-- Assignment helpers (database-driven, never hard-coded)
-- ---------------------------------------------------------------------------
create or replace function public.is_student_mentor(
  p_user_id uuid,
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
      from public.students s
      join public.group_mentors gm on gm.group_id = s.group_id
     where s.id = p_student_id
       and gm.mentor_id = p_user_id
  );
$$;

create or replace function public.is_assigned_master(
  p_user_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.master_assignments ma
     where ma.student_id = p_student_id
       and ma.master_id = p_user_id
  );
$$;

create or replace function public.is_major_head_for_student(
  p_user_id uuid,
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
      from public.students s
      join public.major_heads mh on mh.major_id = s.major_id
     where s.id = p_student_id
       and mh.head_id = p_user_id
  );
$$;

-- ---------------------------------------------------------------------------
-- can_user_read_message — THE single source of truth for message reads.
-- Used by the RLS SELECT policy and by notification recipient filtering,
-- so notifications and access control can never diverge.
-- ---------------------------------------------------------------------------
create or replace function public.can_user_read_message(
  p_user_id uuid,
  p_message_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.student_messages m
     where m.id = p_message_id
       and public.profile_is_authorized(p_user_id)
       and (
         -- 1. privileged global roles read everything
         public.user_is_privileged(p_user_id)
         -- 2. the student's mentor reads everything about their group
         or public.is_student_mentor(p_user_id, m.student_id)
         -- 3./4./5. masters & major heads, unless mentor blocked them
         or (
           not m.is_hidden_from_leads
           and (
             public.is_assigned_master(p_user_id, m.student_id)
             or public.is_major_head_for_student(p_user_id, m.student_id)
           )
         )
         -- 6. mentor-approved general visibility
         or m.is_general_visible
       )
  );
$$;

-- ---------------------------------------------------------------------------
-- can_user_read_student — any authorized staff may browse any student
-- ---------------------------------------------------------------------------
create or replace function public.can_user_read_student()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_authorized_staff();
$$;

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.allowed_staff_emails enable row level security;
alter table public.profiles                enable row level security;
alter table public.user_roles              enable row level security;
alter table public.greenhouse_groups       enable row level security;
alter table public.majors                  enable row level security;
alter table public.students                enable row level security;
alter table public.group_mentors           enable row level security;
alter table public.major_heads             enable row level security;
alter table public.master_assignments      enable row level security;
alter table public.student_messages        enable row level security;
alter table public.message_reads           enable row level security;
alter table public.push_subscriptions      enable row level security;
alter table public.app_settings            enable row level security;
alter table public.audit_logs              enable row level security;

-- ---------------------------------------------------------------------------
-- allowed_staff_emails — readable by super_admin only; writes via service
-- role only (admin server actions). No insert/update/delete policies at all.
-- ---------------------------------------------------------------------------
create policy "allowlist_select_super_admin"
  on public.allowed_staff_emails
  for select to authenticated
  using (public.user_has_role('super_admin'));

-- ---------------------------------------------------------------------------
-- profiles — staff directory; self row always readable; never writable by
-- clients (trigger + missing policies). Admin changes go through service role.
-- ---------------------------------------------------------------------------
create policy "profiles_select_self_or_staff"
  on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_authorized_staff());

-- ---------------------------------------------------------------------------
-- user_roles — readable by staff (UI needs to know its own role);
-- writes only via service role. Nobody can self-elevate.
-- ---------------------------------------------------------------------------
create policy "user_roles_select_staff"
  on public.user_roles
  for select to authenticated
  using (public.is_authorized_staff());

-- ---------------------------------------------------------------------------
-- Org structure: readable by all staff, writable only via service role
-- ---------------------------------------------------------------------------
create policy "groups_select_staff" on public.greenhouse_groups
  for select to authenticated using (public.is_authorized_staff());

create policy "majors_select_staff" on public.majors
  for select to authenticated using (public.is_authorized_staff());

create policy "students_select_staff" on public.students
  for select to authenticated using (public.is_authorized_staff());

create policy "group_mentors_select_staff" on public.group_mentors
  for select to authenticated using (public.is_authorized_staff());

create policy "major_heads_select_staff" on public.major_heads
  for select to authenticated using (public.is_authorized_staff());

create policy "master_assignments_select_staff" on public.master_assignments
  for select to authenticated using (public.is_authorized_staff());

-- ---------------------------------------------------------------------------
-- student_messages
--   select: permission precedence (can_user_read_message)
--   insert: any authorized staff about ANY student; author must be self
--   update: author (body edits) or group mentor (moderation) — fine-grained
--           column enforcement lives in the student_messages_guard trigger
--   delete: not allowed for clients
-- ---------------------------------------------------------------------------
create policy "messages_select"
  on public.student_messages
  for select to authenticated
  using (public.is_authorized_staff() and public.can_user_read_message(auth.uid(), id));

create policy "messages_insert"
  on public.student_messages
  for insert to authenticated
  with check (
    public.is_authorized_staff()
    and author_id = auth.uid()
  );

create policy "messages_update"
  on public.student_messages
  for update to authenticated
  using (
    public.is_authorized_staff()
    and (author_id = auth.uid() or public.is_student_mentor(auth.uid(), student_id))
  )
  with check (
    public.is_authorized_staff()
    and (author_id = auth.uid() or public.is_student_mentor(auth.uid(), student_id))
  );

-- ---------------------------------------------------------------------------
-- message_reads — strictly per-user
-- ---------------------------------------------------------------------------
create policy "message_reads_select_own"
  on public.message_reads
  for select to authenticated
  using (user_id = auth.uid() and public.is_authorized_staff());

create policy "message_reads_insert_own"
  on public.message_reads
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_authorized_staff());

create policy "message_reads_delete_own"
  on public.message_reads
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- push_subscriptions — per-user device management
-- ---------------------------------------------------------------------------
create policy "push_subscriptions_select_own"
  on public.push_subscriptions
  for select to authenticated
  using (user_id = auth.uid() and public.is_authorized_staff());

create policy "push_subscriptions_insert_own"
  on public.push_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_authorized_staff());

create policy "push_subscriptions_update_own"
  on public.push_subscriptions
  for update to authenticated
  using (user_id = auth.uid() and public.is_authorized_staff())
  with check (user_id = auth.uid() and public.is_authorized_staff());

create policy "push_subscriptions_delete_own"
  on public.push_subscriptions
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- app_settings — readable by super_admin (admin settings page); the push
-- sender reads it with the service role. No client writes.
-- ---------------------------------------------------------------------------
create policy "app_settings_select_super_admin"
  on public.app_settings
  for select to authenticated
  using (public.user_has_role('super_admin'));

-- ---------------------------------------------------------------------------
-- audit_logs — no client policies at all: invisible to anon/authenticated.
-- Written by triggers and service-role server actions only.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Client-callable RPCs
-- ============================================================================

-- My students (mentor groups ∪ assigned masters ∪ major-head majors), deduped
create or replace function public.my_students()
returns table (
  id          uuid,
  first_name  text,
  last_name   text,
  group_id    uuid,
  major_id    uuid,
  is_archived boolean,
  created_at  timestamptz,
  updated_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.first_name, s.last_name, s.group_id, s.major_id,
         s.is_archived, s.created_at, s.updated_at
    from public.students s
   where not s.is_archived
     and (
       exists (select 1 from public.group_mentors gm
                where gm.mentor_id = auth.uid() and gm.group_id = s.group_id)
       or exists (select 1 from public.master_assignments ma
                   where ma.master_id = auth.uid() and ma.student_id = s.id)
       or exists (select 1 from public.major_heads mh
                   where mh.head_id = auth.uid() and s.major_id = mh.major_id)
     );
$$;

-- Unread counts per student (visible messages only, per-user read state)
create or replace function public.student_unread_counts()
returns table (student_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select m.student_id, count(*)::bigint as unread_count
    from public.student_messages m
   where not exists (
           select 1 from public.message_reads r
            where r.user_id = auth.uid() and r.message_id = m.id
         )
     and (
       public.user_is_privileged(auth.uid())
       or public.is_student_mentor(auth.uid(), m.student_id)
       or (
         not m.is_hidden_from_leads
         and (
           public.is_assigned_master(auth.uid(), m.student_id)
           or public.is_major_head_for_student(auth.uid(), m.student_id)
         )
       )
       or m.is_general_visible
     )
   group by m.student_id;
$$;

-- Recent unread messages for the updates page / dashboard
create or replace function public.unread_messages(
  p_limit int default 30,
  p_offset int default 0
)
returns table (
  message_id          uuid,
  student_id          uuid,
  student_first_name  text,
  student_last_name   text,
  author_id           uuid,
  author_name         text,
  body                text,
  created_at          timestamptz,
  is_general_visible  boolean,
  is_hidden_from_leads boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, s.id, s.first_name, s.last_name,
         m.author_id, p.full_name, m.body, m.created_at,
         m.is_general_visible, m.is_hidden_from_leads
    from public.student_messages m
    join public.students s on s.id = m.student_id
    join public.profiles p on p.id = m.author_id
   where not exists (
           select 1 from public.message_reads r
            where r.user_id = auth.uid() and r.message_id = m.id
         )
     and (
       public.user_is_privileged(auth.uid())
       or public.is_student_mentor(auth.uid(), m.student_id)
       or (
         not m.is_hidden_from_leads
         and (
           public.is_assigned_master(auth.uid(), m.student_id)
           or public.is_major_head_for_student(auth.uid(), m.student_id)
         )
       )
       or m.is_general_visible
     )
   order by m.created_at desc
   limit p_limit offset p_offset;
$$;

-- Notification recipients: mentors of the group ∪ assigned masters ∪
-- relevant major heads ∪ privileged global roles, minus the author,
-- filtered through the SAME read-permission function used by RLS.
create or replace function public.get_message_recipients(p_message_id uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with msg as (select * from public.student_messages where id = p_message_id)
  select distinct t.uid
    from msg
    cross join lateral (
      select gm.mentor_id as uid
        from public.group_mentors gm
        join public.students s on s.id = (select student_id from msg)
       where s.group_id = gm.group_id
      union
      select ma.master_id
        from public.master_assignments ma
       where ma.student_id = (select student_id from msg)
      union
      select mh.head_id
        from public.major_heads mh
        join public.students s on s.id = (select student_id from msg)
       where s.major_id = mh.major_id
      union
      select ur.user_id
        from public.user_roles ur
       where ur.role in ('counselor', 'project_coordinator', 'leadership')
    ) t
   where t.uid is not null
     and t.uid <> (select author_id from msg)
     and public.can_user_read_message(t.uid, p_message_id);
$$;

-- ---------------------------------------------------------------------------
-- Function grants. RLS policies call some of these functions, so callers
-- need EXECUTE. All are security definer + locked search_path, and every
-- one is bound to auth.uid() internally (except can_user_read_message /
-- get_message_recipients which take an explicit user for reuse in
-- notification routing).
-- ---------------------------------------------------------------------------
revoke all on function public.profile_is_authorized(uuid)              from public, anon;
revoke all on function public.is_authorized_staff()                    from public, anon;
revoke all on function public.user_has_role(app_role, uuid)            from public, anon;
revoke all on function public.is_super_admin(uuid)                     from public, anon;
revoke all on function public.user_is_privileged(uuid)                 from public, anon;
revoke all on function public.is_student_mentor(uuid, uuid)            from public, anon;
revoke all on function public.is_assigned_master(uuid, uuid)           from public, anon;
revoke all on function public.is_major_head_for_student(uuid, uuid)    from public, anon;
revoke all on function public.can_user_read_message(uuid, uuid)        from public, anon;
revoke all on function public.can_user_read_student()                  from public, anon;
revoke all on function public.my_students()                            from public, anon;
revoke all on function public.student_unread_counts()                  from public, anon;
revoke all on function public.unread_messages(int, int)                from public, anon;
revoke all on function public.get_message_recipients(uuid)             from public, anon, authenticated;

grant execute on function public.profile_is_authorized(uuid)           to authenticated, service_role;
grant execute on function public.is_authorized_staff()                 to authenticated, service_role;
grant execute on function public.user_has_role(app_role, uuid)         to authenticated, service_role;
grant execute on function public.is_super_admin(uuid)                  to authenticated, service_role;
grant execute on function public.user_is_privileged(uuid)              to authenticated, service_role;
grant execute on function public.is_student_mentor(uuid, uuid)         to authenticated, service_role;
grant execute on function public.is_assigned_master(uuid, uuid)        to authenticated, service_role;
grant execute on function public.is_major_head_for_student(uuid, uuid) to authenticated, service_role;
grant execute on function public.can_user_read_message(uuid, uuid)     to authenticated, service_role;
grant execute on function public.can_user_read_student()               to authenticated, service_role;
grant execute on function public.my_students()                         to authenticated, service_role;
grant execute on function public.student_unread_counts()               to authenticated, service_role;
grant execute on function public.unread_messages(int, int)             to authenticated, service_role;
grant execute on function public.get_message_recipients(uuid)          to service_role;

-- ============================================================================
-- Table privileges. On hosted Supabase these exist via default privileges;
-- stating them explicitly keeps the least-privilege surface portable and
-- auditable. RLS still gates every row.
-- ============================================================================
grant usage on schema public to anon, authenticated, service_role;

grant select on
  public.allowed_staff_emails, public.profiles, public.user_roles,
  public.greenhouse_groups, public.majors, public.students,
  public.group_mentors, public.major_heads, public.master_assignments,
  public.student_messages, public.message_reads, public.app_settings
  to authenticated;

grant insert, update on public.student_messages to authenticated;
grant insert, delete on public.message_reads to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- ============================================================================
-- Realtime: new messages appear live (RLS still applies to realtime events)
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.student_messages;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;
