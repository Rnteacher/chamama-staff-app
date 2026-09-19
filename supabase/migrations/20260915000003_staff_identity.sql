-- ============================================================================
-- Migration 0003: STAFF IDENTITY MODEL
--
-- Architectural change: `profiles` becomes the application-level staff
-- identity (the "staff_members" table):
--
--   * profiles.id        = STABLE application staff UUID (never changes,
--                          exists BEFORE the person ever logs in)
--   * profiles.auth_user_id = nullable link to auth.users(id), set once at
--                          first successful Google login ("claim")
--   * an ACTIVE row      = the person is authorized to authenticate
--                          (profiles replaces allowed_staff_emails entirely)
--
-- All relationships (roles, mentors, masters, major heads, message
-- authorship, read state, push subscriptions, audit actor) reference
-- profiles.id — the staff identity — never the OAuth account.
--
-- Existing data is preserved: current profile UUIDs remain the staff IDs,
-- roles/assignments/messages/read-state carry over unchanged in meaning.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Drop objects that must be rebuilt under the new model
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

drop trigger if exists trg_allowed_staff_sync on public.allowed_staff_emails;
drop function if exists public.sync_profile_activation();

drop trigger if exists trg_profiles_guard on public.profiles;
drop function if exists public.profiles_guard();

drop trigger if exists trg_student_messages_guard on public.student_messages;
drop function if exists public.student_messages_guard();

drop trigger if exists trg_audit_message_moderation on public.student_messages;
drop function if exists public.audit_message_moderation();

-- policies (rebuilt below)
drop policy if exists "allowlist_select_super_admin"   on public.allowed_staff_emails;
drop policy if exists "profiles_select_self_or_staff"  on public.profiles;
drop policy if exists "user_roles_select_staff"        on public.user_roles;
drop policy if exists "groups_select_staff"            on public.greenhouse_groups;
drop policy if exists "majors_select_staff"            on public.majors;
drop policy if exists "students_select_staff"          on public.students;
drop policy if exists "group_mentors_select_staff"     on public.group_mentors;
drop policy if exists "major_heads_select_staff"       on public.major_heads;
drop policy if exists "master_assignments_select_staff" on public.master_assignments;
drop policy if exists "messages_select"                on public.student_messages;
drop policy if exists "messages_insert"                on public.student_messages;
drop policy if exists "messages_update"                on public.student_messages;
drop policy if exists "message_reads_select_own"       on public.message_reads;
drop policy if exists "message_reads_insert_own"       on public.message_reads;
drop policy if exists "message_reads_delete_own"       on public.message_reads;
drop policy if exists "push_subscriptions_select_own"  on public.push_subscriptions;
drop policy if exists "push_subscriptions_insert_own"  on public.push_subscriptions;
drop policy if exists "push_subscriptions_update_own"  on public.push_subscriptions;
drop policy if exists "push_subscriptions_delete_own"  on public.push_subscriptions;
drop policy if exists "app_settings_select_super_admin" on public.app_settings;

-- old helper/RPC functions (replaced by staff-identity versions)
drop function if exists public.profile_is_authorized(uuid);
drop function if exists public.is_authorized_staff();
drop function if exists public.user_has_role(public.app_role, uuid);
drop function if exists public.is_super_admin(uuid);
drop function if exists public.user_is_privileged(uuid);
drop function if exists public.is_student_mentor(uuid, uuid);
drop function if exists public.is_assigned_master(uuid, uuid);
drop function if exists public.is_major_head_for_student(uuid, uuid);
drop function if exists public.can_user_read_message(uuid, uuid);
drop function if exists public.can_user_read_student();
drop function if exists public.my_students();
drop function if exists public.student_unread_counts();
drop function if exists public.unread_messages(int, int);
drop function if exists public.get_message_recipients(uuid);

-- ---------------------------------------------------------------------------
-- 1. Single source of truth: migrate the allowlist INTO profiles
--    (staff rows that never logged in get a stable UUID; auth_user_id is
--    attached below, after the column exists)
-- ---------------------------------------------------------------------------
insert into public.profiles (email, full_name, is_active)
select a.email, a.full_name, a.is_active
  from public.allowed_staff_emails a
 where not exists (select 1 from public.profiles p where p.email = a.email)
on conflict (email) do nothing;

update public.profiles p
   set is_active = a.is_active
  from public.allowed_staff_emails a
 where p.email = a.email
   and p.is_active <> a.is_active;

-- The allowlist is now fully absorbed into the staff directory.
drop table if exists public.allowed_staff_emails;

-- ---------------------------------------------------------------------------
-- 2. profiles = staff identity
-- ---------------------------------------------------------------------------
-- Detach the primary key from auth.users: existing profile UUIDs become the
-- permanent application staff IDs.
alter table public.profiles drop constraint if exists profiles_id_fkey;

-- Nullable link to the authentication identity (set once at first login).
alter table public.profiles
  add column if not exists auth_user_id uuid references auth.users (id) on delete set null;

-- Backfill: staff who already logged in keep their existing auth identity.
update public.profiles set auth_user_id = id where auth_user_id is null;

-- One auth account can ever be linked to at most one staff identity
-- (multiple NULLs are allowed by a unique constraint).
alter table public.profiles
  drop constraint if exists profiles_auth_user_id_key;
alter table public.profiles
  add constraint profiles_auth_user_id_key unique (auth_user_id);

-- ---------------------------------------------------------------------------
-- 3. Rename relationship columns to staff semantics
--    (all FKs already target profiles.id — the staff identity)
-- ---------------------------------------------------------------------------
alter table public.user_roles          rename column user_id   to staff_id;
alter table public.message_reads       rename column user_id   to staff_id;
alter table public.push_subscriptions  rename column user_id   to staff_id;
alter table public.group_mentors       rename column mentor_id to staff_id;
alter table public.master_assignments  rename column master_id to staff_id;
alter table public.major_heads         rename column head_id   to staff_id;
alter table public.student_messages    rename column author_id to author_staff_id;
alter table public.audit_logs          rename column actor_id  to actor_staff_id;

-- keep the PostgREST embed hint in app code working
alter table public.student_messages
  rename constraint student_messages_author_id_fkey to student_messages_author_staff_id_fkey;

alter index if exists idx_group_mentors_mentor      rename to idx_group_mentors_staff;
alter index if exists idx_master_assignments_master rename to idx_master_assignments_staff;
alter index if exists idx_major_heads_head          rename to idx_major_heads_staff;
alter index if exists idx_messages_author           rename to idx_messages_author_staff;
alter index if exists idx_push_subscriptions_user   rename to idx_push_subscriptions_staff;

-- ---------------------------------------------------------------------------
-- 4. Identity helpers
-- ---------------------------------------------------------------------------

-- The staff identity of the current authenticated Google account.
-- NULL when the account has not claimed a staff identity or the staff
-- record is inactive — every RLS policy resolves identity through this.
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
    from public.profiles p
   where p.auth_user_id = auth.uid()
     and p.is_active
   limit 1;
$$;

-- A specific staff member is authorized (active directory entry).
create or replace function public.staff_is_authorized(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_staff_id
       and p.is_active
  );
$$;

create or replace function public.is_authorized_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_staff_id() is not null;
$$;

-- ---------------------------------------------------------------------------
-- First-login claim: atomically link auth.uid() to the staff record that
-- matches the VERIFIED authenticated email. Never trusts browser input.
-- Returns one of: 'ok' | 'unauthorized' | 'inactive' | 'conflict' | 'unauthenticated' | 'email_unverified'
-- ---------------------------------------------------------------------------
create or replace function public.claim_staff_identity()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.email(), '')));
  v_row   public.profiles;
  v_meta  jsonb;
begin
  if v_uid is null or v_email = '' then
    return 'unauthenticated';
  end if;

  -- Trust only the verified server-side identity claims.
  if not exists (
    select 1 from auth.users u
     where u.id = v_uid
       and u.email_confirmed_at is not null
  ) then
    return 'email_unverified';
  end if;

  select * into v_row from public.profiles where email = v_email;
  if not found then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (null, 'staff_claim_denied', 'staff_member', null,
            jsonb_build_object('reason', 'no_staff_record', 'email', v_email, 'auth_uid', v_uid));
    return 'unauthorized'; -- never auto-create staff from a Google login
  end if;

  if not v_row.is_active then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_row.id, 'staff_claim_denied', 'staff_member', v_row.id,
            jsonb_build_object('reason', 'inactive', 'auth_uid', v_uid));
    return 'inactive';
  end if;

  -- Already linked to this very account → normal sign-in.
  if v_row.auth_user_id = v_uid then
    return 'ok';
  end if;

  -- Linked to a DIFFERENT Google account → deny and record the incident.
  if v_row.auth_user_id is not null then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_row.id, 'staff_claim_conflict', 'staff_member', v_row.id,
            jsonb_build_object('existing_auth_uid', v_row.auth_user_id, 'attempted_auth_uid', v_uid));
    return 'conflict';
  end if;

  -- Atomic claim: only succeeds while auth_user_id is still NULL.
  -- Two simultaneous claims cannot both pass this WHERE clause.
  select coalesce(u.raw_user_meta_data, '{}'::jsonb) into v_meta
    from auth.users u where u.id = v_uid;

  update public.profiles
     set auth_user_id = v_uid,
         full_name    = coalesce(nullif(btrim(coalesce(full_name, '')), ''),
                                 nullif(v_meta ->> 'full_name', ''),
                                 nullif(v_meta ->> 'name', '')),
         avatar_url   = coalesce(avatar_url, v_meta ->> 'avatar_url'),
         updated_at   = now()
   where id = v_row.id
     and auth_user_id is null;

  if not found then
    -- Lost a race: re-read and judge.
    select * into v_row from public.profiles where id = v_row.id;
    if v_row.auth_user_id = v_uid then
      return 'ok';
    end if;
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (v_row.id, 'staff_claim_conflict', 'staff_member', v_row.id,
            jsonb_build_object('existing_auth_uid', v_row.auth_user_id, 'attempted_auth_uid', v_uid));
    return 'conflict';
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_row.id, 'staff_identity_linked', 'staff_member', v_row.id,
          jsonb_build_object('auth_uid', v_uid, 'email', v_email));

  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPC: atomically create a staff member (pre-login) + initial roles.
-- Callable only by a current super_admin (checked inside).
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_staff(
  p_email text,
  p_full_name text,
  p_is_active boolean,
  p_roles public.app_role[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff  uuid := public.current_staff_id();
  v_new_id uuid;
  v_email  text := lower(btrim(p_email));
  r        public.app_role;
begin
  if v_staff is null or not public.staff_has_role(v_staff, 'super_admin') then
    raise exception 'Only a super_admin can create staff members' using errcode = '42501';
  end if;
  if v_email = '' then
    raise exception 'Email is required' using errcode = '23514';
  end if;

  insert into public.profiles (id, email, full_name, is_active, auth_user_id)
  values (gen_random_uuid(), v_email, nullif(btrim(coalesce(p_full_name, '')), ''), p_is_active, null)
  returning id into v_new_id;

  foreach r in array p_roles loop
    insert into public.user_roles (staff_id, role) values (v_new_id, r);
  end loop;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'staff_member_create', 'staff_member', v_new_id,
          jsonb_build_object('email', v_email, 'is_active', p_is_active, 'roles', to_jsonb(p_roles)));

  return v_new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Role / assignment helpers (staff-identity based)
-- ---------------------------------------------------------------------------
create or replace function public.staff_has_role(
  p_staff_id uuid,
  p_role public.app_role
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur
     where ur.staff_id = p_staff_id and ur.role = p_role
  );
$$;

create or replace function public.user_has_role(p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_has_role(public.current_staff_id(), p_role);
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.user_has_role('super_admin');
$$;

-- Privileged global roles: read everything, restrictions never apply
create or replace function public.staff_is_privileged(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur
     where ur.staff_id = p_staff_id
       and ur.role in ('counselor', 'project_coordinator', 'leadership')
  );
$$;

create or replace function public.user_is_privileged()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_is_privileged(public.current_staff_id());
$$;

create or replace function public.is_student_mentor(
  p_staff_id uuid,
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
       and gm.staff_id = p_staff_id
  );
$$;

create or replace function public.is_assigned_master(
  p_staff_id uuid,
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
       and ma.staff_id = p_staff_id
  );
$$;

create or replace function public.is_major_head_for_student(
  p_staff_id uuid,
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
       and mh.staff_id = p_staff_id
  );
$$;

-- THE single source of truth for message reads (mirrors the precedence):
-- 1. counselor / project_coordinator / leadership → everything
-- 2. the student's mentor → everything about their group
-- 3. hidden from leads → masters + major heads (and everyone else except
--    the two above) denied, even if generally visible
-- 4. assigned master → may read
-- 5. relevant major head → may read
-- 6. mentor-approved general visibility → any authorized staff
-- 7. otherwise deny. Authorship alone never grants read access.
create or replace function public.can_user_read_message(
  p_staff_id uuid,
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
       and public.staff_is_authorized(p_staff_id)
       and (
         public.staff_is_privileged(p_staff_id)
         or public.is_student_mentor(p_staff_id, m.student_id)
         or (
           not m.is_hidden_from_leads
           and (
             public.is_assigned_master(p_staff_id, m.student_id)
             or public.is_major_head_for_student(p_staff_id, m.student_id)
           )
         )
         or m.is_general_visible
       )
  );
$$;

-- ---------------------------------------------------------------------------
-- Client-callable RPCs (staff-identity based)
-- ---------------------------------------------------------------------------
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
  with me as (select public.current_staff_id() as sid)
  select s.id, s.first_name, s.last_name, s.group_id, s.major_id,
         s.is_archived, s.created_at, s.updated_at
    from public.students s, me
   where me.sid is not null
     and not s.is_archived
     and (
       exists (select 1 from public.group_mentors gm
                where gm.staff_id = me.sid and gm.group_id = s.group_id)
       or exists (select 1 from public.master_assignments ma
                   where ma.staff_id = me.sid and ma.student_id = s.id)
       or exists (select 1 from public.major_heads mh
                   where mh.staff_id = me.sid and s.major_id = mh.major_id)
     );
$$;

create or replace function public.student_unread_counts()
returns table (student_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select public.current_staff_id() as sid)
  select m.student_id, count(*)::bigint as unread_count
    from public.student_messages m, me
   where me.sid is not null
     and not exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         )
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
   group by m.student_id;
$$;

create or replace function public.unread_messages(
  p_limit int default 30,
  p_offset int default 0
)
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
  is_hidden_from_leads boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select public.current_staff_id() as sid)
  select m.id, s.id, s.first_name, s.last_name,
         m.author_staff_id, p.full_name, m.body, m.created_at,
         m.is_general_visible, m.is_hidden_from_leads
    from public.student_messages m
    join public.students s on s.id = m.student_id
    join public.profiles p on p.id = m.author_staff_id
   cross join me
   where me.sid is not null
     and not exists (
           select 1 from public.message_reads r
            where r.staff_id = me.sid and r.message_id = m.id
         )
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
   limit p_limit offset p_offset;
$$;

-- Notification recipients (staff identities): mentors of the group ∪ assigned
-- masters ∪ relevant major heads ∪ privileged roles, minus the author,
-- filtered through the SAME read-permission function RLS uses.
create or replace function public.get_message_recipients(p_message_id uuid)
returns table (staff_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with msg as (select * from public.student_messages where id = p_message_id)
  select distinct t.sid
    from msg
    cross join lateral (
      select gm.staff_id as sid
        from public.group_mentors gm
        join public.students s on s.id = (select student_id from msg)
       where s.group_id = gm.group_id
      union
      select ma.staff_id
        from public.master_assignments ma
       where ma.student_id = (select student_id from msg)
      union
      select mh.staff_id
        from public.major_heads mh
        join public.students s on s.id = (select student_id from msg)
       where s.major_id = mh.major_id
      union
      select ur.staff_id
        from public.user_roles ur
       where ur.role in ('counselor', 'project_coordinator', 'leadership')
    ) t
   where t.sid is not null
     and t.sid <> (select author_staff_id from msg)
     and public.can_user_read_message(t.sid, p_message_id);
$$;

-- ---------------------------------------------------------------------------
-- 5. Triggers (rebuilt for staff semantics)
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security invoker
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin', 'authenticator') then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.is_active is distinct from old.is_active
     or new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'Forbidden profile modification' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- Message guard: identity rules are now staff-based. System context
-- (seed/maintenance, no JWT) is allowed; real users are always enforced.
create or replace function public.student_messages_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null then
    return new; -- maintenance context only (no authenticated identity)
  end if;

  if (tg_op = 'INSERT') then
    if (new.is_general_visible or new.is_hidden_from_leads)
       and not public.is_student_mentor(v_staff, new.student_id) then
      raise exception 'Only a mentor of this student''s group can set visibility flags'
        using errcode = '42501';
    end if;
    if new.is_general_visible then
      new.general_visible_by := v_staff;
      new.general_visible_at := now();
    end if;
    if new.is_hidden_from_leads then
      new.restriction_changed_by := v_staff;
      new.restriction_changed_at := now();
    end if;
    return new;
  end if;

  -- UPDATE
  if new.author_staff_id is distinct from old.author_staff_id then
    raise exception 'Message author cannot be changed' using errcode = '42501';
  end if;
  if new.student_id is distinct from old.student_id then
    raise exception 'Message student cannot be changed' using errcode = '42501';
  end if;

  if new.body is distinct from old.body then
    if v_staff <> old.author_staff_id then
      raise exception 'Only the author can edit the message body' using errcode = '42501';
    end if;
  end if;

  if (new.is_general_visible, new.is_hidden_from_leads)
       is distinct from (old.is_general_visible, old.is_hidden_from_leads) then
    if not public.is_student_mentor(v_staff, old.student_id) then
      raise exception 'Only a mentor of this student''s group can change message visibility'
        using errcode = '42501';
    end if;
    if new.is_general_visible is distinct from old.is_general_visible then
      new.general_visible_by := v_staff;
      new.general_visible_at := now();
    else
      new.general_visible_by := old.general_visible_by;
      new.general_visible_at := old.general_visible_at;
    end if;
    if new.is_hidden_from_leads is distinct from old.is_hidden_from_leads then
      new.restriction_changed_by := v_staff;
      new.restriction_changed_at := now();
    else
      new.restriction_changed_by := old.restriction_changed_by;
      new.restriction_changed_at := old.restriction_changed_at;
    end if;
  else
    new.general_visible_by     := old.general_visible_by;
    new.general_visible_at     := old.general_visible_at;
    new.restriction_changed_by := old.restriction_changed_by;
    new.restriction_changed_at := old.restriction_changed_at;
  end if;

  if new.body is distinct from old.body then
    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_student_messages_guard on public.student_messages;
create trigger trg_student_messages_guard
  before insert or update on public.student_messages
  for each row execute function public.student_messages_guard();

create or replace function public.audit_message_moderation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_general_visible is distinct from old.is_general_visible then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (
      public.current_staff_id(),
      case when new.is_general_visible
           then 'message_general_visibility_granted'
           else 'message_general_visibility_revoked' end,
      'student_message', new.id,
      jsonb_build_object('student_id', new.student_id)
    );
  end if;
  if new.is_hidden_from_leads is distinct from old.is_hidden_from_leads then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (
      public.current_staff_id(),
      case when new.is_hidden_from_leads
           then 'message_hidden_from_leads'
           else 'message_unhidden_from_leads' end,
      'student_message', new.id,
      jsonb_build_object('student_id', new.student_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_audit_message_moderation on public.student_messages;
create trigger trg_audit_message_moderation
  after update on public.student_messages
  for each row execute function public.audit_message_moderation();

-- ---------------------------------------------------------------------------
-- 6. RLS policies (all identity resolution via current_staff_id())
-- ---------------------------------------------------------------------------

-- staff directory: self row (post-claim) or any authorized staff
create policy "profiles_select_self_or_staff"
  on public.profiles
  for select to authenticated
  using (auth_user_id = auth.uid() or public.is_authorized_staff());

create policy "user_roles_select_staff"
  on public.user_roles
  for select to authenticated
  using (public.is_authorized_staff());

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

-- student_messages
create policy "messages_select"
  on public.student_messages
  for select to authenticated
  using (
    public.is_authorized_staff()
    and public.can_user_read_message(public.current_staff_id(), id)
  );

create policy "messages_insert"
  on public.student_messages
  for insert to authenticated
  with check (
    public.is_authorized_staff()
    and author_staff_id = public.current_staff_id()
  );

create policy "messages_update"
  on public.student_messages
  for update to authenticated
  using (
    public.is_authorized_staff()
    and (
      author_staff_id = public.current_staff_id()
      or public.is_student_mentor(public.current_staff_id(), student_id)
    )
  )
  with check (
    public.is_authorized_staff()
    and (
      author_staff_id = public.current_staff_id()
      or public.is_student_mentor(public.current_staff_id(), student_id)
    )
  );

-- message_reads (strictly per staff identity)
create policy "message_reads_select_own"
  on public.message_reads
  for select to authenticated
  using (staff_id = public.current_staff_id() and public.is_authorized_staff());

create policy "message_reads_insert_own"
  on public.message_reads
  for insert to authenticated
  with check (staff_id = public.current_staff_id() and public.is_authorized_staff());

create policy "message_reads_delete_own"
  on public.message_reads
  for delete to authenticated
  using (staff_id = public.current_staff_id());

-- push_subscriptions (per staff identity / device)
create policy "push_subscriptions_select_own"
  on public.push_subscriptions
  for select to authenticated
  using (staff_id = public.current_staff_id() and public.is_authorized_staff());

create policy "push_subscriptions_insert_own"
  on public.push_subscriptions
  for insert to authenticated
  with check (staff_id = public.current_staff_id() and public.is_authorized_staff());

create policy "push_subscriptions_update_own"
  on public.push_subscriptions
  for update to authenticated
  using (staff_id = public.current_staff_id() and public.is_authorized_staff())
  with check (staff_id = public.current_staff_id() and public.is_authorized_staff());

create policy "push_subscriptions_delete_own"
  on public.push_subscriptions
  for delete to authenticated
  using (staff_id = public.current_staff_id());

-- app_settings: readable by super_admin; writes via service role only
create policy "app_settings_select_super_admin"
  on public.app_settings
  for select to authenticated
  using (public.user_has_role('super_admin'));

-- audit_logs: intentionally NO policies (service role / triggers only)

-- ---------------------------------------------------------------------------
-- 7. Function grants
-- ---------------------------------------------------------------------------
revoke all on function public.current_staff_id()                          from public, anon;
revoke all on function public.staff_is_authorized(uuid)                   from public, anon;
revoke all on function public.is_authorized_staff()                       from public, anon;
revoke all on function public.claim_staff_identity()                      from public, anon;
revoke all on function public.admin_create_staff(text, text, boolean, public.app_role[]) from public, anon, authenticated;
revoke all on function public.staff_has_role(uuid, public.app_role)       from public, anon;
revoke all on function public.user_has_role(public.app_role)              from public, anon;
revoke all on function public.is_super_admin()                            from public, anon;
revoke all on function public.staff_is_privileged(uuid)                   from public, anon;
revoke all on function public.user_is_privileged()                        from public, anon;
revoke all on function public.is_student_mentor(uuid, uuid)               from public, anon;
revoke all on function public.is_assigned_master(uuid, uuid)              from public, anon;
revoke all on function public.is_major_head_for_student(uuid, uuid)       from public, anon;
revoke all on function public.can_user_read_message(uuid, uuid)           from public, anon;
revoke all on function public.my_students()                               from public, anon;
revoke all on function public.student_unread_counts()                     from public, anon;
revoke all on function public.unread_messages(int, int)                   from public, anon;
revoke all on function public.get_message_recipients(uuid)                from public, anon, authenticated;

grant execute on function public.current_staff_id()                        to authenticated, service_role;
grant execute on function public.staff_is_authorized(uuid)                 to authenticated, service_role;
grant execute on function public.is_authorized_staff()                     to authenticated, service_role;
grant execute on function public.claim_staff_identity()                    to authenticated;
grant execute on function public.admin_create_staff(text, text, boolean, public.app_role[]) to authenticated;
grant execute on function public.staff_has_role(uuid, public.app_role)     to authenticated, service_role;
grant execute on function public.user_has_role(public.app_role)            to authenticated, service_role;
grant execute on function public.is_super_admin()                          to authenticated, service_role;
grant execute on function public.staff_is_privileged(uuid)                 to authenticated, service_role;
grant execute on function public.user_is_privileged()                      to authenticated, service_role;
grant execute on function public.is_student_mentor(uuid, uuid)             to authenticated, service_role;
grant execute on function public.is_assigned_master(uuid, uuid)            to authenticated, service_role;
grant execute on function public.is_major_head_for_student(uuid, uuid)     to authenticated, service_role;
grant execute on function public.can_user_read_message(uuid, uuid)         to authenticated, service_role;
grant execute on function public.my_students()                             to authenticated, service_role;
grant execute on function public.student_unread_counts()                   to authenticated, service_role;
grant execute on function public.unread_messages(int, int)                 to authenticated, service_role;
grant execute on function public.get_message_recipients(uuid)              to service_role;
