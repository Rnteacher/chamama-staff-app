-- ============================================================================
-- Migration 20260919000001: AUDIT FIXES
-- View-As, feed form integration, form version immutability, answer validation
-- ============================================================================

-- 1. form_definitions audience refinements
alter table public.form_definitions
  add column if not exists allowed_roles public.app_role[] not null default '{staff}';
alter table public.form_definitions
  add column if not exists require_student_relationship boolean not null default false;

-- 2. form_versions immutability
revoke update, delete on public.form_versions from authenticated, anon, public;

-- 3. student_feed_items v2 — include form submissions
create or replace function public.student_feed_items(p_student_id uuid)
returns table (
  item_id text, kind text, category text, at timestamptz,
  actor_name text, title text, body text,
  held boolean, status text, intervention boolean, read boolean
) language sql stable security definer set search_path = public as $$
  select m.id::text, 'message'::text, 'ongoing'::text,
         m.created_at, p.full_name, null::text, m.body,
         null::boolean, null::text, null::boolean,
         exists (select 1 from public.message_reads r
                  where r.staff_id = public.current_staff_id() and r.message_id = m.id)
    from public.student_messages m
    join public.profiles p on p.id = m.author_staff_id
   where m.student_id = p_student_id
     and public.is_authorized_staff()
     and public.can_user_read_message(public.current_staff_id(), m.id)
  union all
  select r.id::text, 'report'::text,
         case r.context when 'master' then 'project' else 'ongoing' end,
         r.meeting_at, p.full_name,
         case r.context when 'master' then 'דיווח מאסטר' else 'דיווח מנטור' end,
         case when r.held then coalesce(r.next_steps, '') else 'לא התקיימה: ' || coalesce(r.not_held_reason, '') end,
         r.held, r.status, r.intervention, true
    from public.meeting_reports r
    join public.profiles p on p.id = r.staff_id
   where r.student_id = p_student_id and r.deleted_at is null
     and public.can_view_student_reports(public.current_staff_id(), p_student_id)
  union all
  select fs.id::text, 'form'::text, d.feed_category::text,
         fs.submitted_at, coalesce(p.full_name, ''),
         'טופס: ' || d.name, null::text,
         null::boolean, null::text, null::boolean, true
    from public.form_submissions fs
    join public.form_definitions d on d.id = fs.form_definition_id
    left join public.profiles p on p.id = fs.respondent_staff_id
   where fs.subject_student_id = p_student_id and fs.deleted_at is null
     and d.feed_category <> 'hidden'
     and public.is_authorized_staff()
     and (fs.respondent_staff_id = public.current_staff_id()
          or public.can_view_student_reports(public.current_staff_id(), p_student_id))
   order by 4 desc limit 200;
$$;

-- 4. dashboard_rows_view_as (super_admin only, role-scoped read-only)
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
  left join public.majors m on m.id = sp.major_id
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

revoke all on function public.dashboard_rows_view_as(uuid, text) from public, anon;
grant execute on function public.dashboard_rows_view_as(uuid, text) to authenticated;

-- 5. form_versions immutability is enforced by revoking UPDATE/DELETE
--    and by RLS (only SELECT policy exists for coordinator/super_admin)

-- 6. validate_form_answers — server-side submission validation
create or replace function public.validate_form_answers(
  p_schema jsonb, p_answers jsonb
) returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_errors text := '';
  v_fields jsonb := coalesce(p_schema -> 'fields', '[]'::jsonb);
  v_field jsonb; v_key text; v_type text; v_required boolean;
  v_answer jsonb; v_i int; v_opt jsonb; v_valid_vals text[] := '{}';
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('valid', false, 'errors', to_jsonb(array['answers must be an object']));
  end if;
  for v_i in 0 .. jsonb_array_length(v_fields) - 1 loop
    v_field := v_fields -> v_i;
    v_key := v_field ->> 'key';
    v_type := v_field ->> 'type';
    v_required := coalesce((v_field ->> 'required')::boolean, false);
    v_answer := p_answers -> v_key;
    if v_required and (v_answer is null or v_answer = 'null'::jsonb
       or (jsonb_typeof(v_answer) = 'string' and btrim(v_answer #>> '{}') = '')
       or (jsonb_typeof(v_answer) = 'array' and jsonb_array_length(v_answer) = 0)) then
      v_errors := v_errors || 'missing required field: ' || v_key || E'\n';
      continue;
    end if;
    if v_answer is null or v_answer = 'null'::jsonb then continue; end if;
    if v_type = 'single_choice' then
      if jsonb_typeof(v_answer) <> 'string' then
        v_errors := v_errors || 'field ' || v_key || ' must be a string' || E'\n';
      else
        v_valid_vals := '{}';
        for v_opt in select * from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) loop
          v_valid_vals := v_valid_vals || (v_opt ->> 'value');
        end loop;
        if not ((v_answer #>> '{}') = any(v_valid_vals)) then
          v_errors := v_errors || 'field ' || v_key || ' has invalid option' || E'\n';
        end if;
      end if;
    elsif v_type = 'multiple_choice' then
      if jsonb_typeof(v_answer) <> 'array' then
        v_errors := v_errors || 'field ' || v_key || ' must be an array' || E'\n';
      else
        v_valid_vals := '{}';
        for v_opt in select * from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) loop
          v_valid_vals := v_valid_vals || (v_opt ->> 'value');
        end loop;
        for v_opt in select * from jsonb_array_elements(v_answer) loop
          if not ((v_opt #>> '{}') = any(v_valid_vals)) then
            v_errors := v_errors || 'field ' || v_key || ' invalid option' || E'\n';
          end if;
        end loop;
      end if;
    elsif v_type = 'yes_no' then
      if jsonb_typeof(v_answer) = 'string' and (v_answer #>> '{}') not in ('yes','no') then
        v_errors := v_errors || 'field ' || v_key || ' must be yes or no' || E'\n';
      end if;
    elsif v_type in ('number','scale') then
      if jsonb_typeof(v_answer) <> 'number' then
        v_errors := v_errors || 'field ' || v_key || ' must be a number' || E'\n';
      elsif v_type = 'scale' and ((v_answer #>> '{}')::numeric < 1 or (v_answer #>> '{}')::numeric > 5) then
        v_errors := v_errors || 'field ' || v_key || ' must be 1-5' || E'\n';
      end if;
    end if;
  end loop;
  -- reject unknown keys
  declare
    a_key text; v_known boolean;
  begin
    for a_key in select key from jsonb_object_keys(p_answers) as k(key) loop
      v_known := false;
      for v_i in 0 .. jsonb_array_length(v_fields) - 1 loop
        if (v_fields -> v_i ->> 'key') = a_key then v_known := true; exit; end if;
      end loop;
      if not v_known then
        v_errors := v_errors || 'unknown answer key: ' || a_key || E'\n';
      end if;
    end loop;
  end;
  return jsonb_build_object('valid', v_errors = '', 'errors', to_jsonb(string_to_array(btrim(v_errors, E'\n'), E'\n')));
end;
$$;

-- 7. submit_staff_form v2 — role/relationship/answer validation
create or replace function public.submit_staff_form(
  p_form_key text, p_subject_student_id uuid, p_answers jsonb
) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_staff uuid := public.current_staff_id();
  d public.form_definitions;
  v_version public.form_versions;
  v_id uuid; v_validation jsonb;
begin
  if v_staff is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into d from public.form_definitions
   where form_key = p_form_key and status = 'published' and audience = 'staff';
  if d.id is null or d.current_version_id is null then
    raise exception 'Form not found or not published' using errcode = '23514';
  end if;
  if d.allowed_roles is not null and d.allowed_roles <> '{staff}' then
    if not exists (select 1 from public.user_roles ur where ur.staff_id = v_staff and ur.role = any(d.allowed_roles)) then
      raise exception 'Not authorized to submit this form' using errcode = '42501';
    end if;
  end if;
  if d.require_student_relationship and p_subject_student_id is not null then
    if not (public.is_student_mentor(v_staff, p_subject_student_id)
       or public.is_assigned_master(v_staff, p_subject_student_id)
       or public.is_major_head_for_student(v_staff, p_subject_student_id)
       or public.staff_is_privileged(v_staff)
       or public.staff_has_role(v_staff, 'super_admin')) then
      raise exception 'Not authorized for this student' using errcode = '42501';
    end if;
  end if;
  select * into v_version from public.form_versions where id = d.current_version_id;
  if p_subject_student_id is not null and not exists (
    select 1 from public.students s where s.id = p_subject_student_id and not s.is_archived) then
    raise exception 'Student not found' using errcode = '23514';
  end if;
  v_validation := public.validate_form_answers(v_version.schema_json, p_answers);
  if (v_validation ->> 'valid')::boolean is not true then
    raise exception 'Form validation failed: %', (v_validation -> 'errors')::text using errcode = '23514';
  end if;
  insert into public.form_submissions
    (form_definition_id, form_version_id, subject_student_id, respondent_staff_id, answers_json)
  values (d.id, v_version.id, p_subject_student_id, v_staff, coalesce(p_answers, '{}'::jsonb))
  returning id into v_id;
  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'form_submission_created', 'form_submission', v_id,
          jsonb_build_object('form_key', p_form_key, 'subject_student_id', p_subject_student_id));
  return v_id;
end;
$$;

-- 8. public_form_submit v2 — server-side answer validation
create or replace function public.public_form_submit(
  p_token text, p_answers jsonb
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  c public.form_campaigns;
  d public.form_definitions;
  v_version public.form_versions;
  v_submitted int; v_validation jsonb;
begin
  select * into c from public.form_campaigns
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and is_revoked = false limit 1;
  if c.id is null then return jsonb_build_object('status', 'invalid'); end if;
  if now() < c.opens_at then return jsonb_build_object('status', 'not_open'); end if;
  if now() > c.closes_at then return jsonb_build_object('status', 'closed'); end if;
  select * into d from public.form_definitions where id = c.form_definition_id;
  if d.id is null or d.status <> 'published' or d.current_version_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_version from public.form_versions where id = d.current_version_id;
  if not c.allow_resubmit then
    select count(*) into v_submitted from public.form_submissions where campaign_id = c.id;
    if v_submitted > 0 then return jsonb_build_object('status', 'already_submitted'); end if;
  end if;
  v_validation := public.validate_form_answers(v_version.schema_json, p_answers);
  if (v_validation ->> 'valid')::boolean is not true then
    return jsonb_build_object('status', 'error', 'message', 'נתוני הטופס אינם תקינים');
  end if;
  insert into public.form_submissions
    (form_definition_id, form_version_id, subject_student_id, campaign_id, answers_json)
  values (d.id, v_version.id, c.subject_student_id, c.id, coalesce(p_answers, '{}'::jsonb));
  return jsonb_build_object('status', 'ok');
exception when others then
  return jsonb_build_object('status', 'error', 'message', 'השליחה נכשלה. נסו שוב.');
end;
$$;

-- 9. form templates (idempotent — ON CONFLICT on form_key)
-- created_by_staff_id is nullable: system templates are seeded before profiles exist
alter table public.form_definitions alter column created_by_staff_id drop not null;

insert into public.form_definitions (form_key, name, description, audience, feed_category, status, created_by_staff_id)
values
  ('mid_feedback', 'משוב אמצע פרויקט', 'טופס משוב לקראת אמצע הפרויקט', 'staff', 'project', 'draft', null),
  ('final_feedback', 'משוב סיום פרויקט', 'טופס משוב בסיום הפרויקט', 'staff', 'project', 'draft', null),
  ('student_reflection', 'ריפלקציה לחניך', 'ריפלקציה עבור החניך דרך קישור ציבורי', 'public', 'hidden', 'draft', null)
on conflict (form_key) do nothing;

update public.form_definitions
   set draft_schema = '{"version":"1","steps":[{"id":"s1","title":"משוב אמצע"}],"fields":[{"key":"project_status","type":"gyr","label":"מצב הפרויקט","required":true,"stepId":"s1"},{"key":"progress_summary","type":"textarea","label":"סיכום התקדמות","required":true,"stepId":"s1"}],"systemBindings":{"project.status":"project_status"}}'::jsonb
 where form_key = 'mid_feedback' and draft_schema = '{}'::jsonb;

update public.form_definitions
   set draft_schema = '{"version":"1","steps":[{"id":"s1","title":"משוב סיום"}],"fields":[{"key":"project_status","type":"gyr","label":"מצב הפרויקט","required":true,"stepId":"s1"},{"key":"final_summary","type":"textarea","label":"סיכום סיום","required":true,"stepId":"s1"}],"systemBindings":{"project.status":"project_status"}}'::jsonb
 where form_key = 'final_feedback' and draft_schema = '{}'::jsonb;

update public.form_definitions
   set draft_schema = '{"version":"1","steps":[{"id":"s1","title":"ריפלקציה"}],"fields":[{"key":"reflection_text","type":"textarea","label":"הרהורים ומחשבות","required":true,"stepId":"s1"}]}'::jsonb
 where form_key = 'student_reflection' and draft_schema = '{}'::jsonb;
