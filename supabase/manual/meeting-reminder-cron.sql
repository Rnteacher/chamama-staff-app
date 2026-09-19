-- ============================================================================
-- MEETING REMINDER SCHEDULER — Supabase Cron one-time setup
--
-- ⚠️  THIS IS NOT A MIGRATION. Do NOT place it in supabase/migrations/.
-- ⚠️  Replace the two placeholders below with your REAL values BEFORE
--     running, and DO NOT COMMIT the filled-in version:
--
--       1. https://YOUR-PRODUCTION-APP-URL   (no trailing slash)
--       2. YOUR-CRON-SECRET                 (exactly the CRON_SECRET
--                                            configured in Vercel Production)
--
-- The real values are stored in Supabase Vault — they never appear in
-- cron.job, in migrations, or in source control.
--
-- Safe to re-run: secrets are updated in place and the named cron job is
-- replaced (never duplicated).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extensions (if not already enabled from the Dashboard → Integrations)
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Vault: normally enabled from the Dashboard (Integrations → Vault),
-- which creates the `vault` schema. If it is missing, enable it there.
-- create extension if not exists supabase_vault;

-- ---------------------------------------------------------------------------
-- 2. Store the deployment values in Supabase Vault (encrypted at rest)
--    Names used by the cron job: 'app_url' and 'cron_secret'
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  -- 2a. production app URL (no trailing slash!)
  select id into v_id from vault.decrypted_secrets where name = 'app_url' limit 1;
  if v_id is null then
    perform vault.create_secret(
      'https://YOUR-PRODUCTION-APP-URL',       -- ⚠️ REPLACE BEFORE RUNNING
      'app_url',
      'Production base URL of the Chamama staff app (no trailing slash)'
    );
  else
    perform vault.update_secret(v_id, 'https://YOUR-PRODUCTION-APP-URL'); -- ⚠️ REPLACE
  end if;

  -- 2b. CRON_SECRET — must EXACTLY match the CRON_SECRET env var in Vercel Production
  select id into v_id from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_id is null then
    perform vault.create_secret(
      'YOUR-CRON-SECRET',                      -- ⚠️ REPLACE BEFORE RUNNING
      'cron_secret',
      'Bearer secret for /api/cron/meeting-reminders (must match Vercel CRON_SECRET)'
    );
  else
    perform vault.update_secret(v_id, 'YOUR-CRON-SECRET'); -- ⚠️ REPLACE
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Schedule the reminder job (named 'meeting-reminders'; replaces any
--    existing job with the same name — never duplicates)
-- ---------------------------------------------------------------------------
do $$
begin
  -- unschedule silently if a previous run already created it
  begin
    perform cron.unschedule('meeting-reminders');
  exception when others then
    null; -- not scheduled yet
  end;
end;
$$;

select cron.schedule(
  'meeting-reminders',
  '*/5 * * * *', -- every 5 minutes
  $$
  select net.http_get(
    url := (
      select decrypted_secret || '/api/cron/meeting-reminders'
        from vault.decrypted_secrets
       where name = 'app_url'
       limit 1
    ),
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
         where name = 'cron_secret' limit 1
      )
    ),
    timeout_milliseconds := 10000
  ) as request_id;
  $$
);

-- ---------------------------------------------------------------------------
-- 4. Done. Inspect with:
--      select * from cron.job;                                        -- jobs
--      select * from cron.job_run_details order by start_time desc limit 20;
--      select * from net._http_response order by created desc limit 20;
--    (net._http_response keeps the last 6 hours of responses)
-- Remove with:
--      select cron.unschedule('meeting-reminders');
-- ---------------------------------------------------------------------------
