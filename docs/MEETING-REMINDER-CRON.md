# Meeting Reminder Scheduler — Supabase Cron setup (one-time, production)

Vercel **Hobby** only allows cron jobs that run once per day, so the 5-minute
reminder schedule is **not** registered on Vercel. Scheduling authority lives in
**Supabase Cron**:

```
Supabase pg_cron (every 5 minutes)
    → Supabase pg_net HTTP GET
        → GET https://<production-app>/api/cron/meeting-reminders
             Authorization: Bearer <CRON_SECRET>
            → existing Next.js reminder dispatcher
            → existing push system
```

The reminder endpoint (`src/app/api/cron/meeting-reminders/route.ts`) and the
claim/dedup logic (`claim_due_meeting_occurrences`, 60s lease, `notified_at`)
are unchanged — Supabase Cron only replaces Vercel Cron as the trigger.

---

## One-time setup

### A. Vercel

1. Ensure **`CRON_SECRET`** exists in the project's **Production** environment
   variables (Settings → Environment Variables). Generate it with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Redeploy (or rely on the next deploy) — `vercel.json` no longer registers
   any Vercel Cron job, so the Hobby frequency error is gone.

### B. Supabase

1. **Enable extensions** (Dashboard → Database → Extensions), if not enabled:
   - `pg_cron`
   - `pg_net`
   - Vault (Integrations → Vault)
2. Open the SQL Editor and run **`supabase/manual/meeting-reminder-cron.sql`**
   **after replacing its two placeholders**:
   - `https://YOUR-PRODUCTION-APP-URL` → your production app URL (no trailing slash)
   - `YOUR-CRON-SECRET` → **exactly** the same value as `CRON_SECRET` in Vercel

   ⚠️ The script stores both values in **Supabase Vault** (`app_url`,
   `cron_secret`). Do **not** commit the filled-in version, and do not put the
   values anywhere else (migrations, code, `.env` files in git).

The script is **idempotent**: secrets are updated in place if they already
exist, and the named cron job is replaced rather than duplicated.

---

## Inspecting

```sql
-- the scheduled job
select jobid, jobname, schedule, command from cron.job;

-- recent runs (status: succeeded / failed / running...)
select jobid, runid, status, start_time, end_time
  from cron.job_run_details
 order by start_time desc
 limit 20;

-- HTTP responses of the last 6 hours (pg_net keeps them temporarily)
select status_code, content, timed_out, error_msg, created
  from net._http_response
 order by created desc
 limit 20;
```

Expected: `status_code = 200` with a JSON body containing
`"ok": true, "claimed": N, "reminders_sent": M`.

## Manual test (after deployment)

PowerShell:

```powershell
Invoke-WebRequest `
  -Uri "https://<APP_URL>/api/cron/meeting-reminders" `
  -Headers @{ Authorization = "Bearer <CRON_SECRET>" }
```

curl:

```bash
curl -s -H "Authorization: Bearer <CRON_SECRET>" https://<APP_URL>/api/cron/meeting-reminders
```

- correct secret → HTTP 200 `{ "ok": true, ... }`
- wrong/missing secret → HTTP 401 `{"error":"unauthorized"}`
- (if `CRON_SECRET` is missing on the server entirely → HTTP 500)

## Removing / disabling the scheduler

```sql
select cron.unschedule('meeting-reminders');
```

Optionally also delete the Vault secrets:

```sql
delete from vault.decrypted_secrets where name in ('app_url', 'cron_secret');
```

---

## Notes

- `CRON_SECRET` is **server-only**: it lives in Vercel Production env vars and
  in Supabase Vault. It is never `NEXT_PUBLIC_*`, never logged, never in source
  control. `supabase/manual/*.sql` files with real values must never be
  committed.
- Delivery guarantee of the reminder pipeline is **at-least-once with
  concurrency deduplication**: the atomic claim
  (`claim_due_meeting_occurrences`, `FOR UPDATE SKIP LOCKED`, 60s lease)
  prevents two concurrent dispatchers from sending the same occurrence; a
  crash between provider delivery and `notified_at` commit can (rarely) cause
  one duplicate after the lease expires.
- Endpoint authentication uses a constant-time comparison
  (`src/lib/cron-auth.ts`).
