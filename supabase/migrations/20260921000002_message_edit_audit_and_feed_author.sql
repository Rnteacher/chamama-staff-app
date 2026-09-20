-- ============================================================================
-- Migration 20260921000002: MESSAGE EDIT/DELETE SUPPORT + ADMIN ACTIVITY LOG
--
-- Additive. Never modifies an already-deployed migration.
--
-- 1. student_messages.deleted_at (idempotent — complements
--    20260921000001_student_message_softdelete if it was not applied yet)
-- 2. student_feed_items v3 — exposes author_staff_id per feed item so the UI
--    can show Edit/Delete controls ONLY on messages authored by the current
--    staff member (super_admin deletion is decided server-side by the RPC).
-- 3. delete_student_message — re-asserted here so this migration is
--    self-contained regardless of deployment order.
-- 4. Audit trigger: body edits of student messages are audited
--    (author stays unchanged — enforced by the existing guard trigger).
-- 5. recent_audit_logs(p_limit) — security-definer RPC for the admin landing
--    page "לוג פעילות" panel. audit_logs itself stays unreadable by clients.
-- ============================================================================

alter table public.student_messages
  add column if not exists deleted_at timestamptz;

-- ---------------------------------------------------------------------------
-- student_feed_items v3 — adds author_staff_id (null for reports/forms)
--
-- The return shape CHANGES (new output column), which PostgreSQL does not
-- allow via CREATE OR REPLACE. Same pattern as 20260920000001_meeting_report_edit.sql:
-- drop the old signature (no CASCADE — nothing depends on this function),
-- recreate with the complete new shape, then re-apply the exact EXECUTE
-- grants of the currently deployed function.
-- ---------------------------------------------------------------------------
drop function if exists public.student_feed_items(uuid);

create function public.student_feed_items(p_student_id uuid)
returns table (
  item_id    text,
  kind       text,
  category   text,
  at         timestamptz,
  actor_name text,
  title      text,
  body       text,
  held       boolean,
  status     text,
  intervention boolean,
  read       boolean,
  not_held_reason text,
  intervention_categories text[],
  intervention_functional text,
  intervention_emotional text,
  intervention_other text,
  next_steps text,
  meeting_at timestamptz,
  source_id  uuid,
  author_staff_id uuid
) language sql stable security definer set search_path = public as $$
  select m.id::text, 'message'::text, 'ongoing'::text,
         m.created_at, p.full_name, null::text, m.body,
         null::boolean, null::text, null::boolean,
         exists (select 1 from public.message_reads r
                  where r.staff_id = public.current_staff_id() and r.message_id = m.id),
         null::text, null::text[], null::text, null::text, null::text, null::text,
         null::timestamptz, m.id,
         m.author_staff_id
    from public.student_messages m
    join public.profiles p on p.id = m.author_staff_id
   where m.student_id = p_student_id
     and m.deleted_at is null
     and public.is_authorized_staff()
     and public.can_user_read_message(public.current_staff_id(), m.id)
  union all
  select r.id::text, 'report'::text,
         case r.context when 'master' then 'project' else 'ongoing' end,
         r.meeting_at, p.full_name,
         case r.context when 'master' then 'דיווח מאסטר' else 'דיווח מנטור' end,
         case when r.held then coalesce(r.next_steps, '') else 'לא התקיימה: ' || coalesce(r.not_held_reason, '') end,
         r.held, r.status, r.intervention, true,
         r.not_held_reason, r.intervention_categories,
         r.intervention_functional, r.intervention_emotional,
         r.intervention_other, r.next_steps, r.meeting_at, r.id,
         null::uuid
    from public.meeting_reports r
    join public.profiles p on p.id = r.staff_id
   where r.student_id = p_student_id and r.deleted_at is null
     and public.can_view_student_reports(public.current_staff_id(), p_student_id)
  union all
  select fs.id::text, 'form'::text, d.feed_category::text,
         fs.submitted_at, coalesce(p.full_name, ''),
         'טופס: ' || d.name, null::text,
         null::boolean, null::text, null::boolean, true,
         null::text, null::text[], null::text, null::text, null::text, null::text,
         null::timestamptz, fs.id,
         null::uuid
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

revoke all on function public.student_feed_items(uuid) from public, anon;
grant execute on function public.student_feed_items(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- soft-delete a student message (author or super_admin) — re-asserted
-- ---------------------------------------------------------------------------
create or replace function public.delete_student_message(p_message_id uuid)
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

  update public.student_messages
     set deleted_at = now(), updated_at = now()
   where id = p_message_id
     and (author_staff_id = v_staff or public.staff_has_role(v_staff, 'super_admin'));

  if not found then
    raise exception 'Message not found or not yours' using errcode = '42501';
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'student_message_deleted', 'student_message', p_message_id,
          jsonb_build_object('deleted_by', v_staff));

  return true;
end;
$$;

revoke all on function public.delete_student_message(uuid) from public, anon;
grant execute on function public.delete_student_message(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- audit every body edit (author-only edits are enforced by the guard trigger)
-- ---------------------------------------------------------------------------
create or replace function public.audit_student_message_body_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.body is distinct from old.body then
    insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
    values (public.current_staff_id(), 'student_message_edited', 'student_message', new.id,
            jsonb_build_object('student_id', new.student_id));
  end if;
  return null;
end;
$$;

drop trigger if exists trg_audit_message_body_edit on public.student_messages;
create trigger trg_audit_message_body_edit
  after update on public.student_messages
  for each row execute function public.audit_student_message_body_edit();

-- ---------------------------------------------------------------------------
-- admin activity log — newest-first, safe fields only (never report contents)
-- readable ONLY by project coordinator / super_admin through this RPC;
-- audit_logs table itself still has no client policies.
-- ---------------------------------------------------------------------------
create or replace function public.recent_audit_logs(p_limit int default 30)
returns table (
  created_at  timestamptz,
  actor_name  text,
  action      text,
  entity_type text
)
language sql
stable
security definer
set search_path = public
as $$
  select l.created_at, coalesce(p.full_name, '—'), l.action, l.entity_type
    from public.audit_logs l
    left join public.profiles p on p.id = l.actor_staff_id
   where public.current_staff_id() is not null
     and (
       public.staff_has_role(public.current_staff_id(), 'super_admin')
       or public.staff_has_role(public.current_staff_id(), 'project_coordinator')
     )
   order by l.created_at desc
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

revoke all on function public.recent_audit_logs(int) from public, anon;
grant execute on function public.recent_audit_logs(int) to authenticated;
