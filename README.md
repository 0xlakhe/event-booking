# EventBook (TASK-007 early slice)

> Status: Hosted Supabase was provisioned, migrated to `0001_initial` and
> seeded on 2026-10-17. The operator reports a Vercel deployment, but current
> API requests return a sanitized unavailable response. This source adds
> `0002_booking_hard_delete`; it is not applied to hosted PostgreSQL, so the
> new readiness revision and cancellation privilege are not release-ready.

## What exists

- `compose.yaml` with `db`, `backend`, `frontend` (waits for healthy backend),
  and `tools` (profile) services.
- FastAPI backend with `create_app()`, validated config, bounded pool,
  exact CORS, sanitized `/health` (ready only at the configured Alembic head;
  this source now expects `0002_booking_hard_delete`).
- Custom opaque-session auth (`POST /api/auth/register|login|logout`,
  `GET /api/auth/me`): Argon2id hashing, 32-byte tokens stored as
  SHA-256, 24h expiry, role read from the database per request.
- Private `eventbook` schema: `users`, `sessions`, `events`, `bookings`
  with checks, FKs, indexes, and the partial-unique active-booking index.
- Public browsing (`GET /api/events`, `GET /api/events/{id}`): upcoming
  only, seats left, literal title search, server pagination, past detail.
- Own bookings, normal users only (`POST /api/events/{id}/bookings`,
  `GET /api/bookings/me`, `DELETE /api/bookings/{id}`): B1–B4 under the
  event-row lock protocol, cancellation deletes the row and frees the seat;
  admins get 403
  (`ADMIN_BOOKING_FORBIDDEN`) and manage events instead.
- Admin (`GET/POST /api/admin/events`, `PATCH/DELETE
  /api/admin/events/{id}`, `GET .../attendees`): B5–B6, capacity guard,
  deletion policy, active-only attendees.
- Next.js slice (`lib/api.ts` typed client, `lib/auth.tsx` session
  provider, `/login`, `/register`, browsable event list): header-only
  tokens in sessionStorage, hydration validation, loading/error/empty
  states. No Next API routes or Supabase access.
- `vercel.json` deployment contract: one Vercel project with two
  Services (`frontend/` nextjs, `backend/` fastapi); `/api/*` and
  `/health` rewrite to FastAPI, everything else to Next.js.

## Trade-offs (capacity, deletion, time)

- Capacity is enforced by serializing writers on the event row lock and
  counting active bookings after acquiring it — no stored counter, no
  cross-table CHECK possible. Every writer (book, cancel, edit, delete,
  seed) follows the same lock-first protocol.
- Deleting an event with any active booking fails (`EVENT_HAS_BOOKINGS`,
  past events included) to avoid silently cancelling attendees.
  Otherwise the event is deleted and any legacy soft-cancelled rows cascade.
- Started events are read-only for admins (`EVENT_STARTED` on edit or
  delete, judged after the event lock with fresh database time); history
  is preserved, never deleted or rewritten.
- Event times store UTC; admin input requires an explicit offset and the
  UI presents Nepal time. Editing an event into the past is allowed but
  makes later booking/cancellation fail with `EVENT_STARTED`.
- Least-privilege roles: runtime cannot set `users.role` (column INSERT,
  no UPDATE on `users`); migration `0002_booking_hard_delete` grants only the
  booking DELETE needed for cancellation and revokes legacy timestamp UPDATE.
- Repeatable seed: admin/user accounts, 13 events (12 upcoming + 1 past),
  one normal-user booking leaving a capacity-2 event nearly full.
- Isolated pytest suite (110 tests) against `eventbook_test`.

## Versions (hosted PostgreSQL confirmed 2026-10-17)

- PostgreSQL: `postgres:17-alpine` (17.11 local; hosted Supabase 17.11 — reconciled)
- Backend base: `python:3.12-slim`; FastAPI 0.116.1, SQLAlchemy 2.0.35,
  psycopg 3.2.1, Alembic 1.14.1, argon2-cffi 23.1.0, Pydantic 2.9.2
- Frontend base: `node:22-alpine`; Next.js 15.5.28, React 19.1.0, TypeScript 5.6.3

## Local setup

```sh
cp .env.example .env
# Edit .env placeholder passwords locally (never commit).
docker compose config --quiet
docker compose up -d db
docker compose --profile tools run --rm tools python -m app.bootstrap_local
docker compose --profile tools run --rm tools alembic upgrade head
docker compose --profile tools run --rm tools python -m app.seed
docker compose up -d --build backend frontend
curl -i http://localhost:8000/health   # 200 {"status":"ok",...}
open http://localhost:3000/
```

Tests (isolated test database, refuses non-test targets):

```sh
docker compose --profile tools run --rm tools pytest
```

## Data model

- `eventbook.users`: uuid PK, unique normalized email, Argon2id hash,
  `role` server default `'user'`, no runtime UPDATE path to admin.
- `eventbook.sessions`: user FK cascade, unique token hash, 24h-style
  expiry CHECK (enforced by TASK-003 values).
- `eventbook.events`: title/description/venue nonempty, `total_seats > 0`.
- `eventbook.bookings`: user FK restrict, event FK cascade delete,
  legacy `cancelled_at` null-or-after-creation; current API cancellation
  deletes the row. Existing soft-cancelled rows are not cleaned up by migration
  and are excluded from history and capacity counts.
- `seats_left` is computed, never stored. Alembic version row lives in
  `eventbook.alembic_version` (migrator cannot CREATE in `public`);
  runtime holds SELECT on that row only.

## Demo logins (local seed placeholders, not real secrets)

- Admin: `admin@example.com` / `SEED_ADMIN_PASSWORD` from `.env`
- User: `user@example.com` / `SEED_USER_PASSWORD` from `.env`

## Deployment (Vercel Services; not yet deployed)

Production images (local release artifacts; unchanged by the Vercel
config): `backend/Dockerfile` target `prod` (single uvicorn worker, no
reload) and `frontend/Dockerfile` target `prod` (`next build` baked in,
`next start`). Compose pins `target: dev`; build release images
explicitly, e.g. `docker build --target prod -t
eventbook-backend:release ./backend` and `docker build --target prod
--build-arg NEXT_PUBLIC_API_BASE_URL=/api -t
eventbook-frontend:release ./frontend`.

### One Vercel project, two services

`vercel.json` (validated against `https://openapi.vercel.sh/vercel.json`)
deploys both services from one Vercel project:

- `frontend/` — Next.js; publicly reachable for every path except the
  backend rules below.
- `backend/` — FastAPI, entrypoint `app.main:app`; reachable only via
  the `/api/*` and `/health` rewrites. Services are private unless a
  top-level rewrite exposes them, so `/docs`, `/redoc` and
  `/openapi.json` never become public routes, and no service binding is
  used because Next.js never calls FastAPI server-side.

A service rewrite forwards the original path, so FastAPI sees its
existing `/api/...` routes and the browser keeps a direct same-origin
browser-to-API HTTPS path (the design's requirement) with no CORS setup
and no Next.js proxy.

One-time project setup (Root Directory = repository root; framework
preset **Services**):

```sh
vercel link
vercel project update --framework services
vercel env add NEXT_PUBLIC_API_BASE_URL production --no-sensitive   # /api
vercel env add NEXT_PUBLIC_API_BASE_URL preview --no-sensitive      # /api
vercel env add DATABASE_URL production --sensitive                  # postgresql+psycopg://<role>.<project-ref>@<pooler-host>/postgres?sslmode=require
vercel env add APP_ENV production --no-sensitive                    # production
vercel env add ALLOWED_ORIGINS production --no-sensitive            # https://<project>.vercel.app
vercel env add EXPECTED_ALEMBIC_REVISION production --no-sensitive  # 0002_booking_hard_delete
vercel env add DB_POOL_SIZE production --no-sensitive               # e.g. 2
# Preview, only when it gets its own Supabase project/branch:
vercel env add DATABASE_URL preview --sensitive
```

- `DATABASE_URL` must keep the `postgresql+psycopg://` scheme (the
  backend refuses other schemes) and use the Supabase **session-mode
  pooler** host with the limited runtime role, never the migrator. Over
  the shared pooler the username is `<role>.<project-ref>` (a bare role
  name fails with "Tenant or user not found"). Supabase direct
  `db.<ref>` hosts are IPv6-only (not reachable from Vercel functions);
  keep `?sslmode=require` from the dashboard URL.
- `DB_POOL_SIZE` bounds one warm function instance. Fluid compute
  reuses instances, so keep it small (for example 2) to stay inside the
  Supabase pooler's client limit; the Compose default of 5 remains for
  the long-lived local backend.
- Only `NEXT_PUBLIC_*` values are inlined into the browser bundle, so
  `NEXT_PUBLIC_API_BASE_URL=/api` is the only value the browser sees
  (public, inlined at build time; never a secret). Vercel scopes
  variables to the project, not the service, so the backend's
  `DATABASE_URL` also exists in the frontend service's build/runtime
  environment; no frontend code reads it and it is never inlined unless
  prefixed `NEXT_PUBLIC_`.
- Preview deployments: add a Preview `DATABASE_URL` only with a
  separate Supabase project/branch — pointing Preview at the production
  database lets preview traffic mutate live data. With no Preview
  `DATABASE_URL` the backend fails at import (a 500), because settings
  load when the function initializes; the sanitized 503 applies only
  when the URL is set but the database is unreachable.

### Release order (one authorized action; not app or worker startup)

1. **Supabase provisioning — performed manually on the hosted project
   (2026-10-17, SQL editor); a scripted equivalent is still open
   TASK-007 work.** The local bootstrap
   (`python -m app.bootstrap_local`) provisions only the Compose
   databases (`eventbook_dev`/`eventbook_test`) and their roles. The
   hosted setup ran as the project's `postgres` role with this
   idempotent SQL (operator-chosen passwords):

   ```sql
   DO $$
   BEGIN
     IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'eventbook_migrator') THEN
       CREATE ROLE eventbook_migrator LOGIN;
     END IF;
     IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'eventbook_runtime') THEN
       CREATE ROLE eventbook_runtime LOGIN;
     END IF;
   END
   $$;
   ALTER ROLE eventbook_migrator PASSWORD '<migrator-password>';
   ALTER ROLE eventbook_runtime  PASSWORD '<runtime-password>';
   -- Supabase's `postgres` is not a superuser: `CREATE SCHEMA ...
   -- AUTHORIZATION` and `ALTER ... OWNER TO` perform a SET ROLE check
   -- that fails with 42501 unless `postgres` is a member of the role.
   GRANT eventbook_migrator TO postgres;
   GRANT CONNECT ON DATABASE postgres TO eventbook_migrator, eventbook_runtime;
   GRANT CREATE  ON DATABASE postgres TO eventbook_migrator;
   -- Alembic stamps its version table before the migration body runs,
   -- so the schema shell must pre-exist, owned by the migrator.
   CREATE SCHEMA IF NOT EXISTS eventbook AUTHORIZATION eventbook_migrator;
   ALTER SCHEMA eventbook OWNER TO eventbook_migrator;
   ```

   Hosted grants deliberately do not copy the local `REVOKE ... FROM
   PUBLIC` / platform-role revokes onto the shared `postgres` database.
   Verified after provisioning: `anon`, `authenticated` and
   `service_role` have no `eventbook` usage (false/false/false).
2. Migrations and seed from a machine that can reach Supabase and has a
   populated `.env` (Compose still requires the `.env` role/test/seed
   values even for one-off tools runs). Exported values override
   `.env`; export the release seed passwords too, so hosted demo
   accounts do not inherit the local placeholder passwords.

   ```sh
   export MIGRATION_DATABASE_URL='postgresql+psycopg://<migrator>.<project-ref>@<pooler-host>/postgres?sslmode=require'
   export SEED_ADMIN_PASSWORD='<release secret>'
   export SEED_USER_PASSWORD='<release secret>'
   docker compose --profile tools run --rm tools alembic upgrade head
   docker compose --profile tools run --rm tools python -m app.seed
   ```

   Docker Desktop containers have no IPv6 route, so they cannot reach
   the direct `db.<ref>` host (`Network is unreachable`). Use the
   session-pooler URLs above (portable, and the path Vercel uses), or
   run the one-off container with `--network host` to borrow the host
   machine's IPv6 (used once for the initial hosted run).

   The deployed database was last verified at `0001_initial`. Current source
   also requires `0002_booking_hard_delete` before the new readiness revision
   is healthy. Do not deploy this source until an authorized release applies
   the migration and sets `EXPECTED_ALEMBIC_REVISION=0002_booking_hard_delete`.
   The migration changes grants only; it does not delete existing booking rows.

3. `vercel deploy` (Preview) → check the Preview frontend (and
   `vercel curl /api/health --deployment <url>` — it handles Deployment
   Protection — once Preview has its own database) → `vercel deploy
   --prod` → verify `/api/health` (or `/health`) returns 200 with schema
   ready, both demo logins work, and the event list renders on the live
   URL.

Supabase specifics: PostgreSQL 17.11 and TLS (`sslmode=require`) are
confirmed; `anon`/`authenticated`/`service_role` were verified with no
`eventbook` usage (false/false/false, 2026-10-17). Still to confirm on
the dashboard: `eventbook` kept out of the Data API exposed-schema list
and the project's pool/connection limits. Keep the release live two
weeks after submission; record observed cold-start behavior here once a
live URL exists.

Deployment state (2026-10-18): the hosted database was last verified at
`0001_initial`; the operator reports Vercel has been configured and redeployed.
The public frontend loads, but current `/api/events` and `/api/health` requests
return `TEMPORARILY_UNAVAILABLE`. This source requires the unapplied
`0002_booking_hard_delete` migration and matching expected revision. This task
does not apply migrations, change Vercel settings, or redeploy. Resume the
release only with explicit authorization for those external actions.

## Data persistence

- `postgres_data` volume survives `docker compose down` (without `--volumes`).
- `docker compose down --volumes` is a deliberate destructive reset (removes DB + frontend caches).

## What is NOT done

- Full user/admin frontend flows exist (TASK-008: detail, bookings,
  admin UI, Nepal-time handling, lost-response and stale-query guards).
  Seed timestamps are relative to first seeding and age; refresh the
  demo dataset explicitly before submission. One known live-data note:
  the capacity-2 demo event is currently full because a real
  non-seed account booked the last seat; see PROGRESS for the cleanup
  decision owned by the human.
- Backend `healthy` requires schema + configured revision. The local target
  is now `0002_booking_hard_delete`; the hosted migration and live readiness
  remain unverified.
- Commit history has not been independently reviewed. The repository
  exists (`main` ↔ `origin`, GitHub `0xlakhe/event-booking`) and
  `.gitignore` excludes real `.env` files.
- Release migration `0002_booking_hard_delete` and live post-migration
  verification remain pending; do not treat repository code as deployed.
