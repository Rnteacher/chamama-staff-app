# חממה · Chamama Staff App

מערכת פנימית לתקשורת מהירה ומובנית בין אנשי הצוות של **תיכון החממה** על גבי חניכים בודדים —
מנטורים, מאסטרים, ראשי מגמה, ייעוץ, ריכוז פרויקטים והנהלה.

An internal, mobile-first, Hebrew/RTL PWA for structured updates about individual students,
with strict, database-enforced read permissions, per-user read state, Web Push notifications
and a simple admin console.

> **This is NOT an open app.** Only pre-approved, allowlisted staff emails can sign in
> (Google OAuth via Supabase), and every read is enforced by PostgreSQL Row Level Security.

---

## 1. What it does

- **Reach any student in 2–3 taps**: role-aware dashboard → groups/majors/search → student page.
- **Send an update about ANY student** — every authorized staff member can write about every
  student ("שליחת עדכון" button on every student page).
- **Structured visibility model** (see §6): mentors moderate who can read each message
  (general staff / masters & major heads), counselor–coordinator–leadership read everything.
- **Per-user read/unread**: unread badges on home, groups, majors, updates page and bottom nav.
- **Web Push notifications** (VAPID) with privacy-preserving text — the notification never
  contains the message body, and by default not even the student's name.
- **PWA**: installable, standalone display, offline fallback page, service worker.
- **Admin console** (`/admin`, super_admin only): staff allowlist + roles, students, groups,
  majors, master assignments, CSV import, app settings.
- **Audit log** for allowlist changes, role changes, and every mentor moderation action.

## 2. Architecture

| Layer      | Choice |
|------------|--------|
| Framework  | Next.js 16 (App Router, React 19, TypeScript, Turbopack) |
| Styling    | Tailwind CSS v4, RTL-first, Heebo font |
| Backend    | Supabase (PostgreSQL + Auth + Row Level Security + Realtime) |
| Auth       | Google OAuth via Supabase Auth + `allowed_staff_emails` allowlist |
| Mutations  | Server Actions (Zod-validated) + Route Handlers |
| Push       | `web-push` (VAPID), subscriptions per user/device |
| Tests      | Vitest (permission matrix & validation) + SQL RLS suite + Playwright (e2e) |
| Deploy     | Vercel (Node runtime `proxy.ts` guard) + any Supabase project |

**Golden rule of this codebase:** the database is the source of truth for permissions.
The UI only *decorates* what RLS already guarantees. The TypeScript permission mirror
(`src/lib/permissions.ts`) exists solely for rendering decisions and fast unit tests;
every query and mutation is re-authorized by RLS and by server-side checks.

### Authorization flow

```mermaid
flowchart TD
  A[Google login] --> B[Supabase Auth]
  B --> C{email on<br/>allowed_staff_emails<br/>and active?}
  C -- no --> D["/access-denied<br/>(profile.is_active = false)"]
  C -- yes --> E[profile.is_active = true]
  E --> F[proxy.ts guard on every request]
  F --> G[Pages / Server Actions]
  G --> H[PostgreSQL RLS<br/>can_user_read_message()]
  H --> I[student data]
  G --> J[Admin actions<br/>requireSuperAdmin + service role]
  J --> K[audit_logs]
```

### Read-permission precedence (single source of truth: `can_user_read_message`)

```mermaid
flowchart TD
  M[Message about student S] --> P1{"counselor /<br/>project_coordinator /<br/>leadership?"}
  P1 -- yes --> OK[READ]
  P1 -- no --> P2{"mentor of<br/>S's group?"}
  P2 -- yes --> OK
  P2 -- no --> P3{"hidden_from_leads?"}
  P3 -- yes --> DENY[DENY]
  P3 -- no --> P4{"assigned master<br/>of S?"}
  P4 -- yes --> OK
  P4 -- no --> P5{"major head<br/>of S's major?"}
  P5 -- yes --> OK
  P5 -- no --> P6{"is_general_visible<br/>(mentor-approved)?"}
  P6 -- yes --> OK
  P6 -- no --> DENY
```

Notable deliberate rules:

- **Authorship never grants read access.** General staff cannot read their own private
  message (explicit product rule; the composer shows a success state instead).
- **`hidden_from_leads` also hides from general staff** (a lower privilege than masters).
- **`super_admin` is a technical role** and does *not* bypass message privacy.
- Roles are many-to-many (`user_roles`); permissions are additive, with the two explicit
  overrides above.

## 3. Prerequisites

- Node.js 20.9+ (developed on Node 22)
- A Supabase project (free tier is fine)
- A Google Cloud project (for OAuth)
- (optional) Docker, to run the SQL RLS test suite locally
- (optional) Playwright browsers for e2e

## 4. Local setup

```bash
npm install
cp .env.example .env.local   # then fill in the values (see §7, §9)
npm run dev                  # http://localhost:3000
```

## 5. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Copy `Project URL`, `anon key` and `service_role key`
   (Project Settings → API) into `.env.local`.
3. Apply migrations — pick one:
   - **CLI (recommended):** `npx supabase link --project-ref <ref>` then
     `npx supabase db push` — applies everything in `supabase/migrations/`.
   - **SQL editor:** paste the contents of
     `supabase/migrations/20260915000001_init.sql` and
     `supabase/migrations/20260915000002_security.sql` (in that order) and run them.
4. **Seed (development only):** run `supabase/seed.sql` in the SQL editor, or
   `supabase db reset` locally (runs migrations + seed automatically).
   The seed creates fictional staff (`@chamama.example`, password `Chamama2026!`
   for local email login), groups, majors, students, messages in every visibility
   state, and read states. It is idempotent and wipes its own records first.
5. **Auth → Providers → Google**: enable, paste the Google client id/secret (§7).
6. **Auth → URL Configuration**: set Site URL to your deploy URL
   (e.g. `http://localhost:3000` for dev) and add
   `<site>/auth/callback` to Redirect URLs.

> If you use a hosted Supabase with password login disabled (recommended for
> production), seeded users still exist but can only be used against a local stack.

## 6. Database / migrations

Everything lives in reproducible SQL files:

| File | Contents |
|------|----------|
| `supabase/migrations/20260915000001_init.sql` | extensions, `app_role` enum, all tables (profiles, allowed_staff_emails, user_roles, greenhouse_groups, majors, students, group_mentors, major_heads, master_assignments, student_messages, message_reads, push_subscriptions, app_settings, audit_logs), indexes, `updated_at` triggers, profile-creation & allowlist-sync triggers, the `student_messages_guard` trigger (author-only edits, mentor-only visibility flags, server-managed audit columns) and the automatic moderation audit trigger |
| `supabase/migrations/20260915000002_security.sql` | permission helper functions (`is_authorized_staff`, `user_has_role`, `user_is_privileged`, `is_student_mentor`, `is_assigned_master`, `is_major_head_for_student`, **`can_user_read_message`**), RLS enablement + policies on every table, least-privilege grants, RPCs (`my_students`, `student_unread_counts`, `unread_messages`, `get_message_recipients`), realtime publication |
| `supabase/seed.sql` | fictional development data (idempotent) |
| `supabase/tests/rls_tests.sql` | 28 database-level authorization assertions |
| `supabase/tests/local-postgres-stub.sql` | **dev/test only** — minimal `auth` schema stub so the suite runs on vanilla Postgres. Never apply it to a real Supabase project. |

Realtime is enabled for `student_messages` INSERT (RLS applies to realtime too), so the
student feed refreshes live. Realtime is *not* required for correctness — navigation and
refresh always work.

## 7. Google OAuth setup

1. [Google Cloud Console](https://console.cloud.google.com) → create/select a project.
2. **OAuth consent screen**: Internal/External as appropriate; add your staff test users
   if the consent screen is in testing mode.
3. **Credentials → Create OAuth client ID → Web application**:
   - Authorized JavaScript origins: your deploy URL(s), e.g. `http://localhost:3000`
     and `https://your-app.vercel.app`.
   - Authorized redirect URIs: **`https://<PROJECT_REF>.supabase.co/auth/v1/callback`**
     (found under Supabase → Auth → Providers → Google).
4. Paste the client ID + secret into Supabase → Auth → Providers → Google.

After that, the "התחברות עם Google" button on `/login` works end-to-end.

**Remaining dashboard steps are exactly:** Supabase Google provider on/keys, the
callback URL above, Site URL + redirect URLs (§5), and the env vars in §4/§9.

## 8. Staff identity (staff directory)

> Primary-master semantics: master_assignments.is_primary (partial unique index = one
> primary per student) marks the coordinator-selected project master; changing it in
> the intake table replaces the previous primary without touching manually-added
> secondary masters. Meeting reminders use an atomic claim (
otify_started_at +
> FOR UPDATE SKIP LOCKED, 60s lease) so concurrent cron runs never double-send.

The `profiles` table **is the application staff directory** (the "staff_members"
identity): every staff member has a **stable UUID that exists before they ever
log in** (`auth_user_id` is NULL until then). Admins create staff in
`/admin/staff` (name, email, active, roles — atomically via the
`admin_create_staff` RPC) and can immediately assign roles, mentor groups,
masters and major heads **before first login**.

On the first successful Google login, the `claim_staff_identity()` RPC links
the authenticated `auth.uid()` to the existing staff record by the **verified
email claim** (never browser input). The staff UUID never changes; roles and
assignments carry over automatically. Conflicts (a staff record already linked
to a different Google account), unverified emails and unknown accounts are
denied and audited. Unknown Google accounts are **never** auto-registered —
staff identities originate from the admin-created directory only.

- An **active** staff row means the email is allowed to authenticate.
- Every relationship (roles, group mentors, master assignments, major heads,
  message authorship `author_staff_id`, read state, push subscriptions, audit
  actor) references the staff identity — never the OAuth account.
- RLS resolves the current user through `current_staff_id()` (staff row where
  `auth_user_id = auth.uid()` and `is_active`).

Deactivating a staff member (`is_active = false`) instantly locks them out.
Staff CSV import accepts columns `email`, `full_name`.

## 9. VAPID / Web Push setup

```bash
npm run gen:vapid     # prints NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Put both plus `VAPID_SUBJECT` (a `mailto:` contact) into `.env.local` / Vercel env.
Users enable push themselves: home banner or `/settings` → "הפעלת התראות".
Subscriptions are stored per device in `push_subscriptions`; dead subscriptions
(404/410) are pruned automatically on send.

Push privacy: title `חממה – עדכון חדש`, body `התקבל עדכון חדש על חניך` — no message
content. Including the student's *first name* is an admin setting
(`/admin/settings`, default **off**). Clicking a notification deep-links to
`/students/<id>?m=<messageId>`.

### Platform limitations (honest list)

- **iOS/iPadOS**: push requires iOS **16.4+** *and* installing the app to the Home
  Screen first (Share → Add to Home Screen). The app shows this hint in `/settings`.
- Desktop Safari/macOS supports web push (16+).
- All Chromium browsers and Firefox on Android support push directly.
- The app is fully usable when notifications are denied or unsupported — updates always
  appear in the app itself.

## 10. Running locally

```bash
npm run dev          # dev server (Turbopack)
npm run build        # production build
npm run start        # serve production build
```

Optional dev flag: `NEXT_PUBLIC_ENABLE_EMAIL_LOGIN=true` shows an email/password form
on `/login` (useful with seeded users; leave **off** in production).

## 11. Tests

```bash
npm test             # Vitest: permission matrix (TS mirror) + validation schemas  (30 tests)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint (flat config)

# Database RLS suite — the real security enforcement, 28 assertions:
# Option A: local Supabase stack
npx supabase start && npx supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/rls_tests.sql
# Option B: any vanilla Postgres 15+ (e.g. docker run postgres:16):
#   apply supabase/tests/local-postgres-stub.sql, then migrations, then seed, then the suite
```

The RLS suite covers the full matrix: unauthorized/deactivated accounts see nothing;
general-staff read rules (including "authorship ≠ access"); master/major-head access and
its `hidden_from_leads` override; mentor omnipotence + moderation; privileged roles
reading blocked messages; multi-role precedence; per-user read state; role/assignment
tampering attempts; automatic audit of moderation.

### E2E (Playwright)

Specs live in `e2e/` (auth flow, home→group→student navigation, search, sending a
message, mentor approval, read/unread). They require a running stack, so they skip
unless explicitly enabled:

```bash
# 1) local Supabase running with migrations+seed (see §11)
# 2) app running with NEXT_PUBLIC_ENABLE_EMAIL_LOGIN=true
E2E_ENABLED=1 E2E_BASE_URL=http://localhost:3000 npx playwright test
```

## 12. Production build & Vercel deployment

```bash
npm run build && npm run start   # verify locally
```

- Push the repo to GitHub and import it in Vercel (framework auto-detected).
- Add env vars (§4) for Production + Preview: Supabase URL/anon/service keys,
  VAPID keys/subject. Do **not** set `NEXT_PUBLIC_ENABLE_EMAIL_LOGIN` in production.
- Update Google OAuth origins + Supabase Site URL / redirect URLs with the final
  Vercel domain (and add it to Supabase Auth allow-list if IP restrictions apply).
- Vercel runs `next build`; the `proxy.ts` guard runs on the Node runtime.

## 13. PWA installation

- Android/Chrome: install prompt / "Install app" from the browser menu.
- iOS: Share → **Add to Home Screen** (hint shown automatically on iPhones).
- Manifest is generated from `src/app/manifest.ts`; icons derive from the original
  Chamama logo (`public/logo.png`, `public/icons/*`, `src/app/icon.png`).
- Offline: navigations fall back to a friendly offline page; static assets are cached.

## 14. Role / permission model (summary)

| Role | Write messages | Read |
|------|----------------|------|
| `staff` | any student | mentor-approved (general) messages only |
| `mentor` | any student | **everything about their groups**; sole moderator of those messages |
| `master` | any student | everything about assigned students (unless blocked); approved elsewhere |
| `major_head` | any student | everything about students in their major (unless blocked); approved elsewhere |
| `counselor` / `project_coordinator` / `leadership` | any student | **everything, always** |
| `super_admin` | any student | like general staff (technical role, no content privilege) |

Multi-role users get the **highest** applicable permission, except that
`hidden_from_leads` always denies masters/major-heads (mentor & privileged roles still win).
All writes (roles, assignments, allowlist, students, groups, majors) go through
server actions guarded by `requireSuperAdmin()` and the service-role key — never
through client-writable tables.

## 15. Populating real data safely

1. Never import real data into a shared/development Supabase project.
2. Use `/admin/staff` (or staff CSV) to add the real staff emails.
3. Create groups/majors, then students via `/admin/students` (or the students CSV with
   columns `first_name,last_name,group,major`).
4. Assign mentors (groups), heads (majors), masters (students).
5. Assign roles per person; give `super_admin` to 1–2 technical owners only.
6. Delete the fictional seed: run the *wipe* section of `supabase/seed.sql`
   (the statements before the first `insert`) or simply don't run the seed at all in
   production — the seed is for development environments.

## 16. Privacy notes

- No student data on public pages; no analytics; message bodies never logged.
- Push notifications are content-free (name opt-in is first-name-only).
- `audit_logs` are invisible to clients (no RLS policy) — written by triggers/service
  role, reviewed directly in SQL if needed.
- The service-role key is used only inside `server-only` modules (`src/lib/supabase/server.ts`)
  after explicit server-side authorization checks.

---

## Development notes

- `src/proxy.ts` — Next 16 network guard (session refresh + allowlist check).
- `src/lib/actions/` — Server Actions: messages, push, admin (all Zod-validated).
- `src/lib/push/send.ts` — push dispatch; failures are logged, never propagated
  (a message is stored even if every notification fails).
- Hebrew UI strings live inline in components; role labels in `src/lib/constants.ts`.
