-- ============================================================================
-- Migration 20260920000002: CORRECTIONS PHASE
--
-- * delete_meeting_schedule: deactivate (soft) a recurring schedule
-- * intake_windows.deleted_at: soft-delete for intake windows
-- * regenerate_intake_token: rotate a public intake token securely
--   (returns plaintext once; stores hash — same architecture as creation)
-- ============================================================================

-- intake_windows soft-delete
alter table public.intake_windows
  add column if not exists deleted_at timestamptz;

-- ---------------------------------------------------------------------------
-- deactivate a recurring weekly schedule (soft: sets is_active=false)
-- Authorization: schedule owner or super_admin
-- Historical reports and occurrences are NOT deleted.
-- ---------------------------------------------------------------------------
create or replace function public.deactivate_meeting_schedule(p_schedule_id uuid)
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

  update public.meeting_schedules
     set is_active = false, updated_at = now()
   where id = p_schedule_id
     and (staff_id = v_staff or public.staff_has_role(v_staff, 'super_admin'));

  if not found then
    raise exception 'Schedule not found or not yours' using errcode = '42501';
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'meeting_schedule_deactivated', 'meeting_schedule', p_schedule_id,
          jsonb_build_object('deactivated_by', v_staff));

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- rotate/regenerate a public intake token (returns plaintext ONCE; stores hash)
-- Authorization: project coordinator or super_admin
-- Existing links with the old token become invalid; the new link works immediately.
-- ---------------------------------------------------------------------------
create or replace function public.regenerate_intake_token(p_window_id uuid)
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
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  v_token := translate(substr(encode(gen_random_bytes(32), 'base64'), 1, 43), '+/', '-_');

  update public.intake_windows
     set token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
         updated_at = now()
   where id = p_window_id;

  if not found then
    raise exception 'Intake window not found';
  end if;

  insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
  values (v_staff, 'intake_token_regenerated', 'intake_window', p_window_id, '{}');

  return v_token;
end;
$$;

revoke all on function public.deactivate_meeting_schedule(uuid) from public, anon;
revoke all on function public.regenerate_intake_token(uuid) from public, anon, authenticated;
grant execute on function public.deactivate_meeting_schedule(uuid) to authenticated;
grant execute on function public.regenerate_intake_token(uuid) to authenticated;
