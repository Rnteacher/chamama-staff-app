-- ============================================================================
-- תיכון החממה — staff app
-- Migration 0001: core schema, extensions, triggers, indexes
-- ============================================================================

create extension if not exists citext;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles enum (a user may hold many roles — modeled in user_roles, NOT here)
-- ---------------------------------------------------------------------------
create type public.app_role as enum (
  'staff',
  'mentor',
  'master',
  'major_head',
  'counselor',
  'project_coordinator',
  'leadership',
  'super_admin'
);

-- ---------------------------------------------------------------------------
-- allowed_staff_emails — the allowlist. A Google account is NOT authorized
-- unless its normalized email appears here with is_active = true.
-- ---------------------------------------------------------------------------
create table public.allowed_staff_emails (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null unique,
  full_name   text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles — one per auth.users row, created automatically by trigger.
-- is_active mirrors the allowlist; unauthorized accounts stay inactive.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       citext not null unique,
  full_name   text,
  avatar_url  text,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- user_roles — many-to-many; permissions are additive
-- ---------------------------------------------------------------------------
create table public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.app_role not null,
  created_at  timestamptz not null default now(),
  unique (user_id, role)
);

-- ---------------------------------------------------------------------------
-- Groups / majors / students
-- ---------------------------------------------------------------------------
create table public.greenhouse_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.majors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.students (
  id          uuid primary key default gen_random_uuid(),
  first_name  text not null,
  last_name   text not null,
  group_id    uuid references public.greenhouse_groups (id) on delete set null,
  major_id    uuid references public.majors (id) on delete set null,
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- multiple mentors per group
create table public.group_mentors (
  group_id    uuid not null references public.greenhouse_groups (id) on delete cascade,
  mentor_id   uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, mentor_id)
);

-- multiple heads per major
create table public.major_heads (
  major_id    uuid not null references public.majors (id) on delete cascade,
  head_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (major_id, head_id)
);

-- multiple masters per student, one master per many students
create table public.master_assignments (
  student_id  uuid not null references public.students (id) on delete cascade,
  master_id   uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (student_id, master_id)
);

-- ---------------------------------------------------------------------------
-- student_messages — the activity feed. Students are sensitive: every read
-- is governed by RLS (see migration 0002).
--   is_general_visible        : mentor approved visibility for ALL staff
--   is_hidden_from_leads      : mentor blocked message from masters + major
--                               heads (and, by precedence, from general staff)
-- ---------------------------------------------------------------------------
create table public.student_messages (
  id                        uuid primary key default gen_random_uuid(),
  student_id                uuid not null references public.students (id) on delete cascade,
  author_id                 uuid not null references public.profiles (id) on delete cascade,
  body                      text not null check (length(btrim(body)) > 0),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  is_general_visible        boolean not null default false,
  general_visible_by        uuid references public.profiles (id) on delete set null,
  general_visible_at        timestamptz,
  is_hidden_from_leads      boolean not null default false,
  restriction_changed_by    uuid references public.profiles (id) on delete set null,
  restriction_changed_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- message_reads — per-user read state. A missing row means "unread".
-- ---------------------------------------------------------------------------
create table public.message_reads (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  message_id  uuid not null references public.student_messages (id) on delete cascade,
  read_at     timestamptz not null default now(),
  primary key (user_id, message_id)
);

-- ---------------------------------------------------------------------------
-- push_subscriptions — one row per device/browser
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- app_settings — simple key/value application settings
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

insert into public.app_settings (key, value)
values ('include_student_name_in_push', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- audit_logs — written by triggers/service role only; NOT readable by clients
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes for the important access paths
-- ---------------------------------------------------------------------------
create index idx_students_group              on public.students (group_id);
create index idx_students_major              on public.students (major_id);
create index idx_students_archived           on public.students (is_archived);
create index idx_students_full_name_trgm     on public.students using gin ((first_name || ' ' || last_name) gin_trgm_ops);
create index idx_group_mentors_mentor        on public.group_mentors (mentor_id);
create index idx_major_heads_head            on public.major_heads (head_id);
create index idx_master_assignments_master   on public.master_assignments (master_id);
create index idx_messages_student_created    on public.student_messages (student_id, created_at desc);
create index idx_messages_author             on public.student_messages (author_id);
create index idx_message_reads_message       on public.message_reads (message_id);
create index idx_user_roles_role             on public.user_roles (role);
create index idx_push_subscriptions_user     on public.push_subscriptions (user_id);
create index idx_audit_logs_created          on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- Generic updated_at maintenance (only bumps when the row really changed)
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (new is distinct from old) then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'allowed_staff_emails', 'profiles', 'greenhouse_groups', 'majors',
    'students', 'student_messages', 'push_subscriptions'
  ]
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t, t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profile guard: authenticated users may never change id/email/is_active.
-- Privileged maintenance roles (postgres / service_role / supabase_admin,
-- e.g. the allowlist sync trigger and admin server actions) are allowed.
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
     or new.is_active is distinct from old.is_active then
    raise exception 'Forbidden profile modification' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------------
-- handle_new_user — create a profile for every new auth user.
-- The account is active only if the (normalized) email is on an active
-- allowlist entry. Google login does NOT grant access by itself.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text;
  allowed boolean;
begin
  normalized_email := lower(btrim(new.email));
  select coalesce(bool_and(a.is_active), false)
    into allowed
    from public.allowed_staff_emails a
    where a.email = normalized_email;

  insert into public.profiles (id, email, full_name, avatar_url, is_active)
  values (
    new.id,
    normalized_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url',
    allowed
  )
  on conflict (id) do update
    set email      = excluded.email,
        full_name  = coalesce(excluded.full_name, public.profiles.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Allowlist <-> profile activation sync: adding / updating / removing an
-- allowlist entry immediately activates / deactivates matching profiles.
-- ---------------------------------------------------------------------------
create or replace function public.sync_profile_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'DELETE') then
    update public.profiles set is_active = false where email = old.email and is_active;
    return old;
  end if;

  update public.profiles p
     set is_active = new.is_active
   where p.email = new.email
     and p.is_active <> new.is_active;

  return coalesce(new, null);
end;
$$;

drop trigger if exists trg_allowed_staff_sync on public.allowed_staff_emails;
create trigger trg_allowed_staff_sync
  after insert or update or delete on public.allowed_staff_emails
  for each row execute function public.sync_profile_activation();

-- ---------------------------------------------------------------------------
-- student_messages guard — fine-grained, column-level enforcement that RLS
-- row policies cannot express on their own:
--   * author_id / student_id are immutable
--   * only the author may edit the body
--   * only a mentor of the student's group may touch visibility flags
--   * audit columns are maintained server-side, never client-controlled
-- ---------------------------------------------------------------------------
create or replace function public.student_messages_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  -- System/maintenance context (seed, service jobs): no user identity exists.
  -- Real users ALWAYS carry a JWT here, so enforcement can never be skipped
  -- by them (the function runs as definer, so current_user is useless here).
  if actor is null then
    return new;
  end if;

  if (tg_op = 'INSERT') then
    if (new.is_general_visible or new.is_hidden_from_leads)
       and not public.is_student_mentor(actor, new.student_id) then
      raise exception 'Only a mentor of this student''s group can set visibility flags'
        using errcode = '42501';
    end if;
    if new.is_general_visible then
      new.general_visible_by := actor;
      new.general_visible_at := now();
    end if;
    if new.is_hidden_from_leads then
      new.restriction_changed_by := actor;
      new.restriction_changed_at := now();
    end if;
    return new;
  end if;

  -- UPDATE
  if new.author_id is distinct from old.author_id then
    raise exception 'Message author cannot be changed' using errcode = '42501';
  end if;
  if new.student_id is distinct from old.student_id then
    raise exception 'Message student cannot be changed' using errcode = '42501';
  end if;

  if new.body is distinct from old.body then
    if actor is null or actor <> old.author_id then
      raise exception 'Only the author can edit the message body' using errcode = '42501';
    end if;
  end if;

  if (new.is_general_visible, new.is_hidden_from_leads)
       is distinct from (old.is_general_visible, old.is_hidden_from_leads) then
    if not public.is_student_mentor(actor, old.student_id) then
      raise exception 'Only a mentor of this student''s group can change message visibility'
        using errcode = '42501';
    end if;
    if new.is_general_visible is distinct from old.is_general_visible then
      new.general_visible_by := actor;
      new.general_visible_at := now();
    else
      new.general_visible_by := old.general_visible_by;
      new.general_visible_at := old.general_visible_at;
    end if;
    if new.is_hidden_from_leads is distinct from old.is_hidden_from_leads then
      new.restriction_changed_by := actor;
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

-- ---------------------------------------------------------------------------
-- Audit trail for mentor moderation (automatic, server-side)
-- ---------------------------------------------------------------------------
create or replace function public.audit_message_moderation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_general_visible is distinct from old.is_general_visible then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      case when new.is_general_visible
           then 'message_general_visibility_granted'
           else 'message_general_visibility_revoked' end,
      'student_message', new.id,
      jsonb_build_object('student_id', new.student_id)
    );
  end if;
  if new.is_hidden_from_leads is distinct from old.is_hidden_from_leads then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
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
