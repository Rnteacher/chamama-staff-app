-- ============================================================================
-- DEV/TEST ONLY — minimal Supabase-compatible stub for vanilla Postgres.
-- Lets supabase/migrations + supabase/seed.sql + supabase/tests/rls_tests.sql
-- run against a plain PostgreSQL container (no Supabase stack).
--
-- NEVER apply this to a real Supabase project: it would shadow the auth
-- schema. Real Supabase projects already provide everything defined here.
-- ============================================================================

-- Supabase roles
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- auth schema stub
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key,
  instance_id uuid,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language plpgsql
stable
as $$
declare
  claims text := current_setting('request.jwt.claims', true);
  sub text := current_setting('request.jwt.claim.sub', true);
begin
  -- Claims may be unset (NULL) or an empty string (after local revert).
  if claims is not null and claims <> '' then
    begin
      return nullif(claims::jsonb ->> 'sub', '')::uuid;
    exception when others then
      return nullif(sub, '')::uuid;
    end;
  end if;
  return nullif(sub, '')::uuid;
end $$;

grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema auth grant execute on functions to anon, authenticated, service_role;
