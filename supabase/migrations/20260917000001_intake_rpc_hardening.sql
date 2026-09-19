-- ============================================================================
-- Migration 20260917000001: INTAKE RPC HARDENING (error-state separation)
--
-- Production correction: public_intake_overview was a LANGUAGE SQL function
-- whose body selected FROM the token resolver. Any zero-row outcome returned
-- NULL, and ANY runtime error inside the body made the RPC fail — both were
-- indistinguishable to the page, which then displayed "invalid link" for
-- every backend failure.
--
-- All five public intake RPCs are now plpgsql that ALWAYS return a status:
--   'open' | 'not_open' | 'closed' | 'invalid' | 'error'
-- (students/majors/masters return '[]' on unexpected errors; submit returns
--  {status:'error'}). Unexpected failures never surface as 'invalid' and
-- never leak database details to anonymous callers.
--
-- The token hash representation stays exactly ONE canonical form on both
-- sides (creation + lookup):
--     encode(sha256(convert_to(<raw token>, 'UTF8')), 'hex')   -- lowercase hex
-- ============================================================================

-- ---------------------------------------------------------------------------
-- shared resolver: returns the window row, or NULL when not found/revoked
-- ---------------------------------------------------------------------------
create or replace function public.intake_window_for_token(p_token text)
returns public.intake_windows
language sql
stable
security definer
set search_path = public
as $$
  -- canonical token hash: built-in sha256 (PG11+), lowercase hex — the same
  -- value the admin action computes with Node crypto (sha256 over UTF-8).
  select w.*
    from public.intake_windows w
   where w.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and w.is_revoked = false
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- overview: ALWAYS returns one jsonb with a status
-- ---------------------------------------------------------------------------
create or replace function public.public_intake_overview(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.intake_windows;
begin
  select * into w from public.intake_window_for_token(p_token);

  if w.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if now() < w.opens_at then
    return jsonb_build_object('status', 'not_open', 'title', w.title, 'opens_at', w.opens_at);
  end if;
  if now() > w.closes_at then
    return jsonb_build_object('status', 'closed', 'title', w.title, 'closes_at', w.closes_at);
  end if;

  return jsonb_build_object(
    'status', 'open',
    'title', w.title,
    'opens_at', w.opens_at,
    'closes_at', w.closes_at,
    'groups', (
      select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name), '[]'::jsonb)
      from public.greenhouse_groups g
    )
  );
exception
  when others then
    -- unexpected server-side failure: generic technical error, never 'invalid'
    return jsonb_build_object('status', 'error');
end;
$$;

-- ---------------------------------------------------------------------------
-- students of a chosen group (only while open)
-- ---------------------------------------------------------------------------
create or replace function public.public_intake_students(p_token text, p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.intake_windows;
begin
  w := public.intake_window_for_token(p_token);
  if w.id is null or now() < w.opens_at or now() > w.closes_at then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'first_name', s.first_name, 'last_name', s.last_name)
           order by s.first_name, s.last_name)
    from public.students s
   where s.group_id = p_group_id
     and s.is_archived = false
  ), '[]'::jsonb);
exception
  when others then
    return '[]'::jsonb;
end;
$$;

-- ---------------------------------------------------------------------------
-- majors for the major question (only while open)
-- ---------------------------------------------------------------------------
create or replace function public.public_intake_majors(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.intake_windows;
begin
  w := public.intake_window_for_token(p_token);
  if w.id is null or now() < w.opens_at or now() > w.closes_at then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.name)
    from public.majors m
  ), '[]'::jsonb);
exception
  when others then
    return '[]'::jsonb;
end;
$$;

-- ---------------------------------------------------------------------------
-- requested-master choices: ACTIVE staff, name only (only while open)
-- ---------------------------------------------------------------------------
create or replace function public.public_intake_masters(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.intake_windows;
begin
  w := public.intake_window_for_token(p_token);
  if w.id is null or now() < w.opens_at or now() > w.closes_at then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, '')) order by coalesce(p.full_name, ''))
    from public.profiles p
   where p.is_active
  ), '[]'::jsonb);
exception
  when others then
    return '[]'::jsonb;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit (idempotent per intake+student; server revalidates everything)
-- ---------------------------------------------------------------------------
create or replace function public.public_intake_submit(
  p_token text,
  p_student_id uuid,
  p_group_id uuid,
  p_intent text,
  p_major_id uuid,
  p_master_staff_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  w public.intake_windows;
  v_student public.students;
  v_intent text := btrim(coalesce(p_intent, ''));
begin
  w := public.intake_window_for_token(p_token);
  if w.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if now() < w.opens_at then
    return jsonb_build_object('status', 'not_open');
  end if;
  if now() > w.closes_at then
    return jsonb_build_object('status', 'closed');
  end if;

  if v_intent = '' or length(v_intent) > 500 then
    return jsonb_build_object('status', 'error', 'message', 'נסחו משפט אחד באורך של עד 500 תווים');
  end if;

  select * into v_student from public.students where id = p_student_id;
  if v_student.id is null or v_student.is_archived or v_student.group_id is null
     or v_student.group_id <> p_group_id then
    return jsonb_build_object('status', 'error', 'message', 'בחירת הקבוצה או החניך/ה אינה תקינה');
  end if;

  if p_major_id is not null and not exists (select 1 from public.majors m where m.id = p_major_id) then
    return jsonb_build_object('status', 'error', 'message', 'המגמה שנבחרה אינה קיימת');
  end if;

  if p_master_staff_id is null or not exists (
    select 1 from public.profiles p where p.id = p_master_staff_id and p.is_active
  ) then
    return jsonb_build_object('status', 'error', 'message', 'המאסטר/ית המבוקש/ת אינו/ה זמין/ה');
  end if;

  insert into public.intake_submissions
    (intake_id, student_id, intent_text, major_id, requested_master_staff_id)
  values
    (w.id, p_student_id, v_intent, p_major_id, p_master_staff_id)
  on conflict (intake_id, student_id) do update
    set intent_text               = excluded.intent_text,
        major_id                  = excluded.major_id,
        requested_master_staff_id = excluded.requested_master_staff_id,
        updated_at                = now();

  return jsonb_build_object('status', 'ok');
exception
  when others then
    return jsonb_build_object('status', 'error', 'message', 'השליחה נכשלה. נסו שוב.');
end;
$$;

-- ---------------------------------------------------------------------------
-- grants (unchanged semantics: RPC-only public interface, no anon table access)
-- ---------------------------------------------------------------------------
revoke all on function public.intake_window_for_token(text)          from public, anon, authenticated;
revoke all on function public.public_intake_overview(text)           from public, anon, authenticated;
revoke all on function public.public_intake_students(text, uuid)     from public, anon, authenticated;
revoke all on function public.public_intake_majors(text)             from public, anon, authenticated;
revoke all on function public.public_intake_masters(text)            from public, anon, authenticated;
revoke all on function public.public_intake_submit(text, uuid, uuid, text, uuid, uuid) from public, anon, authenticated;

grant execute on function public.intake_window_for_token(text)       to service_role;
grant execute on function public.public_intake_overview(text)        to anon;
grant execute on function public.public_intake_students(text, uuid)  to anon;
grant execute on function public.public_intake_majors(text)          to anon;
grant execute on function public.public_intake_masters(text)         to anon;
grant execute on function public.public_intake_submit(text, uuid, uuid, text, uuid, uuid) to anon;
