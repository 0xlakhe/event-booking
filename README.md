# EventBook (TASK-007 early slice)

> Status: release preparation complete (auth/browse frontend slice,
> production images, release runbook); external deployment blocked on
> missing hosting access — see Deployment below. No live URLs yet.

## What exists

- `compose.yaml` with `db`, `backend`, `frontend` (waits for healthy backend),
  and `tools` (profile) services.
- FastAPI backend with `create_app()`, validated config, bounded pool,
  exact CORS, sanitized `/health` (200 with schema + revision `0001_initial`).
- Custom opaque-session auth (`POST /api/auth/register|login|logout`,
  `GET /api/auth/me`): Argon2id hashing, 32-byte tokens stored as
  SHA-256, 24h expiry, role read from the database per request.
- Private `eventbook` schema: `users`, `sessions`, `events`, `bookings`
  with checks, FKs, indexes, and the partial-unique active-booking index.
- Public browsing (`GET /api/events`, `GET /api/events/{id}`): upcoming
  only, seats left, literal title search, server pagination, past detail.
- Own bookings, normal users only (`POST /api/events/{id}/bookings`,
  `GET /api/bookings/me`, `DELETE /api/bookings/{id}`): B1–B4 under the
  event-row lock protocol, cancellation frees the seat; admins get 403
  (`ADMIN_BOOKING_FORBIDDEN`) and manage events instead.
- Admin (`GET/POST /api/admin/events`, `PATCH/DELETE
  /api/admin/events/{id}`, `GET .../attendees`): B5–B6, capacity guard,
  deletion policy, active-only attendees.
- Next.js slice (`lib/api.ts` typed client, `lib/auth.tsx` session
  provider, `/login`, `/register`, browsable event list): header-only
  tokens in sessionStorage, hydration validation, loading/error/empty
  states. No Next API routes or Supabase access.

## Trade-offs (capacity, deletion, time)

- Capacity is enforced by serializing writers on the event row lock and
  counting active bookings after acquiring it — no stored counter, no
  cross-table CHECK possible. Every writer (book, cancel, edit, delete,
  seed) follows the same lock-first protocol.
- Deleting an event with any active booking fails (`EVENT_HAS_BOOKINGS`,
  past events included) to avoid silently cancelling attendees.
  Otherwise the event is deleted and its cancelled history cascades.
- Started events are read-only for admins (`EVENT_STARTED` on edit or
  delete, judged after the event lock with fresh database time); history
  is preserved, never deleted or rewritten.
- Event times store UTC; admin input requires an explicit offset and the
  UI presents Nepal time. Editing an event into the past is allowed but
  makes later booking/cancellation fail with `EVENT_STARTED`.
- Least-privilege roles: runtime cannot set `users.role` (column INSERT,
  no UPDATE on `users`), cancellation flips `cancelled_at` only.
- Repeatable seed: admin/user accounts, 13 events (12 upcoming + 1 past),
  one normal-user booking leaving a capacity-2 event nearly full.
- Isolated pytest suite (108 tests) against `eventbook_test`.

## Versions (provisional — no Supabase project access yet)

- PostgreSQL: `postgres:17-alpine` (running 17.11; reconcile at TASK-007)
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
  `cancelled_at` null-or-after-creation; active rows unique per user+event.
- `seats_left` is computed, never stored. Alembic version row lives in
  `eventbook.alembic_version` (migrator cannot CREATE in `public`);
  runtime holds SELECT on that row only.

## Demo logins (local seed placeholders, not real secrets)

- Admin: `admin@example.com` / `SEED_ADMIN_PASSWORD` from `.env`
- User: `user@example.com` / `SEED_USER_PASSWORD` from `.env`

## Deployment (release preparation; not yet deployed)

Production images: `backend/Dockerfile` target `prod` (single uvicorn
worker, no reload) and `frontend/Dockerfile` target `prod`
(`next build` baked in, `next start`). Compose pins `target: dev`;
build release images explicitly, e.g.
`docker build --target prod -t eventbook-backend:release ./backend` and
`docker build --target prod --build-arg
NEXT_PUBLIC_API_BASE_URL=https://api.example.com/api -t
eventbook-frontend:release ./frontend`.

Production environment (backend only; never the frontend):
`DATABASE_URL` with the Supabase **session-mode pooler** URL and the
limited runtime role, `ALLOWED_ORIGINS` set to the exact deployed
frontend origin (CORS is checked exactly — a missing origin fails
closed, as observed locally), `EXPECTED_ALEMBIC_REVISION=0001_initial`.
Frontend gets only `NEXT_PUBLIC_API_BASE_URL` (deployed HTTPS API URL,
baked at image build time).

Release as one authorized action (not worker startup), in order:
bootstrap roles → `alembic upgrade head` via `MIGRATION_DATABASE_URL` →
`python -m app.seed` → verify `/health` 200, both demo logins, and the
event list. Supabase specifics to confirm on the project: PostgreSQL
major version, TLS, pool limits, `eventbook` schema kept out of the
Data API exposed list, and `anon`/`authenticated` with no eventbook
grants. Keep the release live two weeks after submission; document the
backend sleep behavior here if the host sleeps.

Missing before any external deployment (no access exists yet): a
Supabase project (URL + DB password + pooler URL), frontend host
(Vercel/Netlify or alternative) and backend host (Render/Railway or
alternative) accounts, GitHub repository + evaluator access, and human
authorization for each external step. Nothing has been deployed; there
are no live URLs.

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
- Backend `healthy` requires schema + revision (verified 200 since
  TASK-002 migrated).
- Commit history has not been independently reviewed. The repository
  exists (`main` ↔ `origin`, GitHub `0xlakhe/event-booking`) and
  `.gitignore` excludes real `.env` files.
- No external deployment (blocked: see Deployment above for the exact
  missing inputs). Local release artifacts verified instead.
