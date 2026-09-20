-- ============================================================================
-- Migration 20260921000002: STUDENT MESSAGE SOFT DELETE
-- ============================================================================

alter table public.student_messages
  add column if not exists deleted_at timestamptz;

-- exclude deleted messages from the unified feed
create or replace function public.student_feed_items(p_student_id uuid)
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
  source_id  uuid
) language sql stable security definer set search_path = public as $$
  select m.id::text, 'message'::text, 'ongoing'::text,
         m.created_at, p.full_name, null::text, m.body,
         null::boolean, null::text, null::boolean,
         exists (select 1 from public.message_reads r
                  where r.staff_id = public.current_staff_id() and r.message_id = m.id),
         null::text, null::text[], null::text, null::text, null::text, null::text,
         null::timestamptz, m.id
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
         r.intervention_other, r.next_steps, r.meeting_at, r.id
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
         null::timestamptz, fs.id
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
-- soft-delete a student message (author or super_admin)
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
