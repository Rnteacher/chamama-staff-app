-- ============================================================================
-- Migration 20260918000002: FORM ENGINE
--
-- Database-backed dynamic forms:
--   form_definitions  — identity/lifecycle/ownership (draft→published→archived)
--   form_versions     — immutable published schema_json snapshots
--   form_submissions  — answers bound to the exact version + subject context
--   form_campaigns    — public token links (hash-only at rest, time window)
--
-- schema_json shape (version 1):
-- {
--   "version": 1,
--   "steps":   [{ "id": "s1", "title": "…" }],
--   "fields":  [{
--     "key": "stable_key", "type": "short_text", "label": "…",
--     "help": "…", "required": false, "stepId": "s1",
--     "options": [{ "value": "a", "label": "…" }],
--     "visibleWhen": { "field": "f2", "op": "eq", "value": "yes" },
--     "branch": { "when": { "field": "f2", "op": "eq", "value": "no" },
--                 "gotoStep": "s3" }
--   }],
--   "systemBindings": { "project.status": "f_status" }
-- }
-- Field keys are stable technical identifiers — never the Hebrew label.
-- ============================================================================

create table public.form_definitions (
  id                  uuid primary key default gen_random_uuid(),
  form_key            text not null unique,
  name                text not null check (length(btrim(name)) between 1 and 120),
  description         text,
  audience            text not null check (audience in ('staff', 'public')),
  feed_category       text not null default 'hidden' check (feed_category in ('hidden', 'ongoing', 'project')),
  status              text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  draft_schema        jsonb not null default '{}'::jsonb,
  current_version_id  uuid,
  archived_at         timestamptz,
  created_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.form_versions (
  id                  uuid primary key default gen_random_uuid(),
  form_definition_id  uuid not null references public.form_definitions (id) on delete cascade,
  version_number      int not null,
  schema_json         jsonb not null,
  published_at        timestamptz not null default now(),
  created_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  unique (form_definition_id, version_number)
);

alter table public.form_definitions
  add constraint form_definitions_current_version_fk
  foreign key (current_version_id) references public.form_versions (id);

create table public.form_submissions (
  id                  uuid primary key default gen_random_uuid(),
  form_definition_id  uuid not null references public.form_definitions (id) on delete cascade,
  form_version_id     uuid not null references public.form_versions (id),
  subject_student_id  uuid references public.students (id) on delete cascade,
  respondent_staff_id uuid references public.profiles (id),
  campaign_id         uuid,
  answers_json        jsonb not null default '{}'::jsonb,
  submitted_at        timestamptz not null default now(),
  deleted_at          timestamptz
);

create index idx_form_submissions_student on public.form_submissions (subject_student_id, submitted_at desc);
create index idx_form_submissions_definition on public.form_submissions (form_definition_id, submitted_at desc);

create table public.form_campaigns (
  id                  uuid primary key default gen_random_uuid(),
  form_definition_id  uuid not null references public.form_definitions (id) on delete cascade,
  token_hash          text not null unique,
  opens_at            timestamptz not null,
  closes_at           timestamptz not null,
  is_revoked          boolean not null default false,
  subject_student_id  uuid references public.students (id) on delete cascade,
  allow_resubmit      boolean not null default true,
  created_by_staff_id uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint form_campaign_times_valid check (opens_at < closes_at)
);

create index idx_form_campaigns_definition on public.form_campaigns (form_definition_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['form_definitions','form_campaigns']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- schema validation (authoritative at publish; TS mirror used in the builder)
-- ---------------------------------------------------------------------------
create or replace function public.validate_form_schema(p_schema jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_errors text := '';
  v_steps jsonb;
  v_fields jsonb;
  v_step_ids text[] := '{}';
  v_field_keys text[] := '{}';
  v_field jsonb;
  v_step jsonb;
  v_type text;
  v_key text;
  v_i int;
  v_cond jsonb;
  v_branch jsonb;
  v_target text;
  v_edges jsonb := '[]'::jsonb;
begin
  if p_schema is null or jsonb_typeof(p_schema) <> 'object' then
    v_errors := v_errors || 'schema must be an object' || chr(10);
    return jsonb_build_object('valid', false, 'errors', to_jsonb(v_errors));
  end if;

  if coalesce((p_schema ->> 'version'), '') <> '1' then
    v_errors := v_errors || 'schema version must be "1"' || chr(10);
  end if;

  v_steps := coalesce(p_schema -> 'steps', '[]'::jsonb);
  v_fields := coalesce(p_schema -> 'fields', '[]'::jsonb);

  if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) = 0 then
    v_errors := v_errors || 'at least one step is required' || chr(10);
  else
    for v_i in 0 .. jsonb_array_length(v_steps) - 1 loop
      v_step := v_steps -> v_i;
      v_key := v_step ->> 'id';
      if v_key is null or v_key = '' then
        v_errors := v_errors || 'every step requires an id' || chr(10);
      elsif v_key = any(v_step_ids) then
        v_errors := v_errors || 'duplicate step id: ' || v_key || chr(10);
      else
        v_step_ids := v_step_ids || v_key;
      end if;
    end loop;
  end if;

  if jsonb_typeof(v_fields) <> 'array' or jsonb_array_length(v_fields) = 0 then
    v_errors := v_errors || 'at least one field is required' || chr(10);
  else
    for v_i in 0 .. jsonb_array_length(v_fields) - 1 loop
      v_field := v_fields -> v_i;
      v_key := v_field ->> 'key';
      v_type := v_field ->> 'type';
      if v_key is null or v_key = '' then
        v_errors := v_errors || 'every field requires a key' || chr(10);
      elsif v_key = any(v_field_keys) then
        v_errors := v_errors || 'duplicate field key: ' || v_key || chr(10);
      else
        v_field_keys := v_field_keys || v_key;
      end if;

      if v_type is null or v_type not in (
        'short_text','long_text','single_choice','multiple_choice','yes_no',
        'number','scale','date','time','datetime','gyr','student_selector',
        'group_selector','major_selector','staff_selector','heading','acknowledgement'
      ) then
        v_errors := v_errors || 'unknown field type: ' || coalesce(v_type, '(null)') || chr(10);
      end if;

      if v_type in ('single_choice','multiple_choice') then
        if jsonb_typeof(v_field -> 'options') <> 'array'
           or jsonb_array_length(v_field -> 'options') = 0 then
          v_errors := v_errors || 'choice field requires options: ' || v_key || chr(10);
        end if;
      end if;

      -- step assignment must reference an existing step
      if (v_field ->> 'stepId') is not null
         and not ((v_field ->> 'stepId') = any(v_step_ids)) then
        v_errors := v_errors || 'field references unknown step: ' || v_key || chr(10);
      end if;

      -- visibility condition
      v_cond := v_field -> 'visibleWhen';
      if v_cond is not null and jsonb_typeof(v_cond) = 'object' then
        if not exists (select 1 from jsonb_array_elements(v_fields) f
                       where f ->> 'key' = (v_cond ->> 'field')) then
          v_errors := v_errors || 'visibleWhen references unknown field: ' || v_key || chr(10);
        end if;
        if (v_cond ->> 'op') not in ('eq','neq','contains') then
          v_errors := v_errors || 'visibleWhen has invalid op: ' || v_key || chr(10);
        end if;
      end if;

      -- branching
      v_branch := v_field -> 'branch';
      if v_branch is not null and jsonb_typeof(v_branch) = 'object' then
        v_cond := v_branch -> 'when';
        if v_cond is not null and not exists (select 1 from jsonb_array_elements(v_fields) f
                       where f ->> 'key' = (v_cond ->> 'field')) then
          v_errors := v_errors || 'branch references unknown field: ' || v_key || chr(10);
        end if;
        v_target := v_branch ->> 'gotoStep';
        if v_target is null or not (v_target = any(v_step_ids)) then
          v_errors := v_errors || 'branch references unknown step: ' || v_key || chr(10);
        else
          v_edges := v_edges || jsonb_build_object(
            'from', coalesce(v_field ->> 'stepId', ''),
            'to', v_target);
        end if;
      end if;
    end loop;
  end if;

  -- branch cycle detection (DFS over step edges)
  if v_errors = '' then
    declare
      v_visited text[] := '{}';
      v_stack text[] := '{}';
      v_from text;
    begin
      for v_from in select coalesce(f ->> 'stepId', '') from jsonb_array_elements(v_fields) f
                    where f -> 'branch' is not null loop
        v_visited := '{}'; v_stack := '{}';
        if public._form_branch_reaches(v_from, v_from, v_edges, v_visited, v_stack) then
          v_errors := v_errors || 'branching creates a loop reaching step: ' || v_from;
          exit;
        end if;
      end loop;
    end;
  end if;

  -- system bindings must reference existing field keys
  if jsonb_typeof(p_schema -> 'systemBindings') = 'object' then
    declare
      b_key text;
      b_field text;
    begin
      for b_key, b_field in select key, value #>> '{}' from jsonb_each(p_schema -> 'systemBindings') loop
        if not (b_field = any(v_field_keys)) then
          v_errors := v_errors || 'system binding "' || b_key || '" references unknown field: ' || coalesce(b_field, '');
        end if;
      end loop;
    end;
  end if;

  return jsonb_build_object('valid', v_errors = '', 'errors', to_jsonb(string_to_array(btrim(v_errors, chr(10)), chr(10))));
end;
$$;

-- helper for the branch-cycle DFS
create or replace function public._form_branch_reaches(
  p_current text,
  p_target text,
  p_edges jsonb,
  p_visited text[],
  p_stack text[]
)
returns boolean
language plpgsql
volatile
as $$
declare
  e jsonb;
  v_next text;
begin
  if p_current = p_target and array_position(p_stack, p_current) is not null then
    return true;
  end if;
  if p_current = any(p_visited) then
    return false;
  end if;
  p_visited := p_visited || p_current;
  p_stack := p_stack || p_current;
  for e in select * from jsonb_array_elements(p_edges) where value ->> 'from' = p_current loop
    v_next := e ->> 'to';
    if public._form_branch_reaches(v_next, p_target, p_edges, p_visited, p_stack) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin RPCs (caller must be project coordinator or super_admin — verified
-- inside; audit for lifecycle events)
-- ---------------------------------------------------------------------------
create or replace function public.form_create(
  p_form_key text,
  p_name text,
  p_description text,
  p_audience text,
  p_feed_category text,
  p_draft_schema jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_id uuid;
begin
  if v_staff is null or not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Only a project coordinator or super_admin can create forms'
      using errcode = '42501';
  end if;
  if coalesce(p_form_key, '') !~ '^[a-z0-9_]{3,60}$' then
    raise exception 'form_key must be 3-60 chars: a-z, 0-9, _';
  end if;
  if p_audience not in ('staff', 'public') then
    raise exception 'invalid audience';
  end if;
  if p_feed_category not in ('hidden', 'ongoing', 'project') then
    raise exception 'invalid feed category';
  end if;

  insert into public.form_definitions
    (form_key, name, description, audience, feed_category, draft_schema, created_by_staff_id)
  values
    (p_form_key, p_name, nullif(btrim(coalesce(p_description, '')), ''),
     p_audience, p_feed_category, coalesce(p_draft_schema, '{}'::jsonb), v_staff)
  returning id into v_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_create', 'form_definition', v_id,
          jsonb_build_object('form_key', p_form_key, 'audience', p_audience));

  return v_id;
end;
$$;

create or replace function public.form_save_draft(
  p_form_id uuid,
  p_name text,
  p_description text,
  p_feed_category text,
  p_draft_schema jsonb
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
  if v_staff is null or not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Only a project coordinator or super_admin can edit forms'
      using errcode = '42501';
  end if;

  update public.form_definitions
     set name = coalesce(p_name, name),
         description = coalesce(p_description, description),
         feed_category = coalesce(p_feed_category, feed_category),
         draft_schema = coalesce(p_draft_schema, draft_schema)
   where id = p_form_id
     and status <> 'archived';
  if not found then
    raise exception 'Form not found or archived';
  end if;

  return true;
end;
$$;

create or replace function public.form_publish(p_form_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_def public.form_definitions;
  v_check jsonb;
  v_version int;
begin
  if v_staff is null or not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Only a project coordinator or super_admin can publish forms'
      using errcode = '42501';
  end if;

  select * into v_def from public.form_definitions where id = p_form_id;
  if v_def.id is null or v_def.status = 'archived' then
    raise exception 'Form not found or archived';
  end if;

  v_check := public.validate_form_schema(v_def.draft_schema);
  if (v_check ->> 'valid')::boolean is not true then
    raise exception 'Form schema is invalid: %', (v_check -> 'errors')::text
      using errcode = '23514';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_version
    from public.form_versions where form_definition_id = v_def.id;

  insert into public.form_versions
    (form_definition_id, version_number, schema_json, created_by_staff_id)
  values
    (v_def.id, v_version, v_def.draft_schema, v_staff)
  returning version_number into v_version;

  update public.form_definitions
     set status = 'published',
         current_version_id = (select id from public.form_versions
                                where form_definition_id = v_def.id
                                  and version_number = v_version)
   where id = v_def.id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_publish', 'form_definition', v_def.id,
          jsonb_build_object('version', v_version));

  return v_version;
end;
$$;

create or replace function public.form_archive(p_form_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null or not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Only a project coordinator or super_admin can archive forms'
      using errcode = '42501';
  end if;

  update public.form_definitions
     set status = 'archived', archived_at = now()
   where id = p_form_id and status <> 'archived';

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_archive', 'form_definition', p_form_id, '{}');

  return true;
end;
$$;

-- hard delete only for a DRAFT with zero submissions
create or replace function public.form_delete_draft(p_form_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null or not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Only a project coordinator or super_admin can delete forms'
      using errcode = '42501';
  end if;

  if exists (select 1 from public.form_submissions where form_definition_id = p_form_id) then
    raise exception 'Form has submissions — archive it instead' using errcode = '23514';
  end if;

  delete from public.form_definitions
   where id = p_form_id and status = 'draft';
  if not found then
    raise exception 'Only draft forms without submissions can be deleted';
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_delete_draft', 'form_definition', p_form_id, '{}');

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- public campaign (token link) for public-audience forms
-- ---------------------------------------------------------------------------
create or replace function public.form_campaign_create(
  p_form_id uuid,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_subject_student_id uuid,
  p_allow_resubmit boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_token text;
begin
  if v_staff is null or not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Only a project coordinator or super_admin can create form links'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.form_definitions
                  where id = p_form_id and audience = 'public' and status = 'published') then
    raise exception 'Form must be published with a public audience';
  end if;
  if p_opens_at is null or p_closes_at is null or p_opens_at >= p_closes_at then
    raise exception 'Invalid time window';
  end if;

  v_token := translate(substr(encode(gen_random_bytes(32), 'base64'), 1, 43), '+/', '-_');

  insert into public.form_campaigns
    (form_definition_id, token_hash, opens_at, closes_at, subject_student_id,
     allow_resubmit, created_by_staff_id)
  values
    (p_form_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
     p_opens_at, p_closes_at, p_subject_student_id,
     coalesce(p_allow_resubmit, true), v_staff);

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_campaign_create', 'form_campaign', null,
          jsonb_build_object('form_id', p_form_id, 'subject_student_id', p_subject_student_id));

  return v_token; -- plaintext shown ONCE; only the hash is stored
end;
$$;

create or replace function public.form_campaign_revoke(p_campaign_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null or not (
    public.staff_has_role(v_staff, 'super_admin')
    or public.staff_has_role(v_staff, 'project_coordinator')
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update public.form_campaigns set is_revoked = true, updated_at = now()
   where id = p_campaign_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_campaign_revoke', 'form_campaign', p_campaign_id, '{}');

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- public RPCs (anon + authenticated; token-gated; no table access)
-- ---------------------------------------------------------------------------
create or replace function public.public_form_overview(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.form_campaigns;
  d public.form_definitions;
  v_version public.form_versions;
  v_student public.students;
begin
  select * into c from public.form_campaigns
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and is_revoked = false limit 1;
  if c.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if now() < c.opens_at then
    return jsonb_build_object('status', 'not_open', 'opens_at', c.opens_at);
  end if;
  if now() > c.closes_at then
    return jsonb_build_object('status', 'closed', 'closes_at', c.closes_at);
  end if;

  select * into d from public.form_definitions where id = c.form_definition_id;
  if d.id is null or d.status <> 'published' or d.audience <> 'public' or d.current_version_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_version from public.form_versions where id = d.current_version_id;

  if c.subject_student_id is not null then
    select * into v_student from public.students where id = c.subject_student_id;
  end if;

  return jsonb_build_object(
    'status', 'open',
    'form_name', d.name,
    'description', d.description,
    'schema', v_version.schema_json,
    'version_number', v_version.version_number,
    'subject_student', case when v_student.id is null then null
      else jsonb_build_object('id', v_student.id, 'first_name', v_student.first_name) end
  );
exception
  when others then
    return jsonb_build_object('status', 'error');
end;
$$;

create or replace function public.public_form_submit(
  p_token text,
  p_answers jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c public.form_campaigns;
  d public.form_definitions;
  v_version public.form_versions;
  v_submitted int;
begin
  select * into c from public.form_campaigns
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and is_revoked = false limit 1;
  if c.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if now() < c.opens_at then
    return jsonb_build_object('status', 'not_open');
  end if;
  if now() > c.closes_at then
    return jsonb_build_object('status', 'closed');
  end if;

  select * into d from public.form_definitions where id = c.form_definition_id;
  if d.id is null or d.status <> 'published' or d.current_version_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_version from public.form_versions where id = d.current_version_id;

  if not c.allow_resubmit then
    -- one submission per campaign per browser-submitted context: the token
    -- itself gates a single subject, so reuse of the link is blocked
    select count(*) into v_submitted
      from public.form_submissions where campaign_id = c.id;
    if v_submitted > 0 then
      return jsonb_build_object('status', 'already_submitted');
    end if;
  end if;

  insert into public.form_submissions
    (form_definition_id, form_version_id, subject_student_id, campaign_id, answers_json)
  values
    (d.id, v_version.id, c.subject_student_id, c.id, coalesce(p_answers, '{}'::jsonb));

  return jsonb_build_object('status', 'ok');
exception
  when others then
    return jsonb_build_object('status', 'error', 'message', 'השליחה נכשלה. נסו שוב.');
end;
$$;

-- ---------------------------------------------------------------------------
-- authenticated staff submission (respondent derived from current_staff_id)
-- ---------------------------------------------------------------------------
create or replace function public.submit_staff_form(
  p_form_key text,
  p_subject_student_id uuid,
  p_answers jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  d public.form_definitions;
  v_version public.form_versions;
  v_id uuid;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into d from public.form_definitions
   where form_key = p_form_key and status = 'published' and audience = 'staff';
  if d.id is null or d.current_version_id is null then
    raise exception 'Form not found or not published' using errcode = '23514';
  end if;
  select * into v_version from public.form_versions where id = d.current_version_id;

  if p_subject_student_id is not null and not exists (
    select 1 from public.students s where s.id = p_subject_student_id and not s.is_archived) then
    raise exception 'Student not found' using errcode = '23514';
  end if;

  insert into public.form_submissions
    (form_definition_id, form_version_id, subject_student_id, respondent_staff_id, answers_json)
  values
    (d.id, v_version.id, p_subject_student_id, v_staff, coalesce(p_answers, '{}'::jsonb))
  returning id into v_id;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_submission_created', 'form_submission', v_id,
          jsonb_build_object('form_key', p_form_key, 'subject_student_id', p_subject_student_id));

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- form submission feed items for the student timeline
-- ---------------------------------------------------------------------------
create or replace function public.student_form_feed_items(p_student_id uuid)
returns table (
  submission_id uuid,
  form_name text,
  category text,
  submitted_at timestamptz,
  respondent_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select fs.id, d.name, d.feed_category, fs.submitted_at, coalesce(p.full_name, '')
    from public.form_submissions fs
    join public.form_definitions d on d.id = fs.form_definition_id
    left join public.profiles p on p.id = fs.respondent_staff_id
   where fs.subject_student_id = p_student_id
     and fs.deleted_at is null
     and d.feed_category <> 'hidden'
     and public.is_authorized_staff()
     and (fs.respondent_staff_id = public.current_staff_id()
          or public.can_view_student_reports(public.current_staff_id(), p_student_id));
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.form_definitions enable row level security;
alter table public.form_versions    enable row level security;
alter table public.form_submissions enable row level security;
alter table public.form_campaigns   enable row level security;

create policy "form_definitions_select_coordinator"
  on public.form_definitions for select to authenticated
  using (
    public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
  );

create policy "form_versions_select_coordinator"
  on public.form_versions for select to authenticated
  using (
    exists (select 1 from public.form_definitions d
             where d.id = form_versions.form_definition_id)
    and public.staff_has_role(public.current_staff_id(), 'super_admin')
  );

create policy "form_submissions_select"
  on public.form_submissions for select to authenticated
  using (
    respondent_staff_id = public.current_staff_id()
    or public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
    or public.can_view_student_reports(public.current_staff_id(), subject_student_id)
  );

create policy "form_campaigns_select_coordinator"
  on public.form_campaigns for select to authenticated
  using (
    public.staff_has_role(public.current_staff_id(), 'super_admin')
    or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
  );

-- writes happen via the security-definer RPCs / service role only
-- (no insert/update/delete policies for clients)

-- ---------------------------------------------------------------------------
-- grants — same public/anon+authenticated pattern as the intake RPCs
-- ---------------------------------------------------------------------------
revoke all on function public.validate_form_schema(jsonb)                     from public, anon, authenticated;
revoke all on function public._form_branch_reaches(text, text, jsonb, text[], text[]) from public, anon, authenticated;
revoke all on function public.form_create(text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.form_save_draft(uuid, text, text, text, jsonb)  from public, anon, authenticated;
revoke all on function public.form_publish(uuid)                              from public, anon, authenticated;
revoke all on function public.form_archive(uuid)                              from public, anon, authenticated;
revoke all on function public.form_delete_draft(uuid)                         from public, anon, authenticated;
revoke all on function public.form_campaign_create(uuid, timestamptz, timestamptz, uuid, boolean) from public, anon, authenticated;
revoke all on function public.form_campaign_revoke(uuid)                      from public, anon, authenticated;
revoke all on function public.public_form_overview(text)                      from public, anon, authenticated;
revoke all on function public.public_form_submit(text, jsonb)                 from public, anon, authenticated;
revoke all on function public.submit_staff_form(text, uuid, jsonb)            from public, anon, authenticated;
revoke all on function public.student_form_feed_items(uuid)                   from public, anon;

grant execute on function public.validate_form_schema(jsonb)                  to authenticated, service_role;
grant execute on function public.form_create(text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.form_save_draft(uuid, text, text, text, jsonb)   to authenticated;
grant execute on function public.form_publish(uuid)                           to authenticated;
grant execute on function public.form_archive(uuid)                           to authenticated;
grant execute on function public.form_delete_draft(uuid)                      to authenticated;
grant execute on function public.form_campaign_create(uuid, timestamptz, timestamptz, uuid, boolean) to authenticated;
grant execute on function public.form_campaign_revoke(uuid)                   to authenticated;
grant execute on function public.public_form_overview(text)                   to anon, authenticated;
grant execute on function public.public_form_submit(text, jsonb)              to anon, authenticated;
grant execute on function public.submit_staff_form(text, uuid, jsonb)         to authenticated;
grant execute on function public.student_form_feed_items(uuid)                to authenticated;

-- table grants: authenticated can read definitions/versions (published forms
-- render via RPC; management reads via coordinator RLS), submissions/campaigns
-- per RLS policies above
grant select on public.form_definitions to authenticated;
grant select on public.form_versions    to authenticated;
grant select on public.form_submissions to authenticated;
grant select on public.form_campaigns   to authenticated;
grant all on public.form_definitions to service_role;
grant all on public.form_versions    to service_role;
grant all on public.form_submissions to service_role;
grant all on public.form_campaigns   to service_role;
