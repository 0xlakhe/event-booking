# EventBook

EventBook is a small full-stack event booking application: admins publish events with fixed
capacity, visitors browse and search upcoming events, and registered users book or cancel a
single seat per event. Simultaneous bookings for the last seat are made safe with a database
row-lock protocol — seats are never overbooked.

**Live app:** <https://event-booking-chi-seven.vercel.app> — the API is served same-origin under
`/api`, and readiness is reported at `/health`.

**Docs:** [requirements](docs/REQUIREMENTS.md) · [technical design](docs/TECHNICAL_DESIGN.md) ·
[implementation plan](docs/IMPLEMENTATION_PLAN.md) · [progress and evidence log](docs/PROGRESS.md)

**Stack:** Next.js 15 · FastAPI · PostgreSQL · Docker Compose locally ·
one Vercel project with two Services and Supabase PostgreSQL in production.

## Table of contents

- [Live demo](#live-demo)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Tests](#tests)
- [API](#api)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Known issues and next steps](#known-issues-and-next-steps)
- [How this was built](#how-this-was-built-ai-disclosure)

## Live demo

- **Admin:** `admin@admin.com` · **User:** `user@example.com`. Passwords are provided with the
  submission. Registering a new account works too.
- **Suggested tour:** browse and search the events list → open an event → book a seat → cancel it
  from "My bookings" → log in as the admin → create, edit, or delete an event (started events are
  read-only).
- Live demo data can drift while people test — bookings and admin edits are real. The seed state
  and every verification detail are recorded in [docs/PROGRESS.md](docs/PROGRESS.md).

## Features

- **Browse and search** — paginated upcoming events with live seat counts, literal title search,
  and detail pages with description, venue, Nepal-time start, and availability.
- **Accounts** — register, log in, log out with opaque session tokens (Argon2id password hashes,
  32-byte tokens stored as SHA-256, 24-hour expiry); `user` and `admin` roles are read from the
  database on every request; repeated failed logins are throttled per client address + account
  (`429 TOO_MANY_ATTEMPTS` with `Retry-After`).
- **Booking** — one active seat per user per event, booked and cancelled under a database
  row-lock protocol; a cancellation frees the seat immediately; "My bookings" lists and cancels
  bookings.
- **Admin** — create, edit, and delete events with a capacity guard, plus attendee lists. Started
  events are read-only so history is never rewritten.
- **UX safeguards** — the events list remembers its scroll position across navigation (including
  after a booking); bounded 30-second in-memory caches; stale-response, lost-response, and
  account-switch guards; accessible loading, error, and empty states.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 15.5.28 (App Router), React 19.1.0, TypeScript 5.6.3; Vitest 3.2.7 + Testing Library |
| Backend | Python 3.12, FastAPI 0.116.1, SQLAlchemy 2.0.35, psycopg 3.2.1, Alembic 1.14.1, argon2-cffi 23.1.0, Pydantic 2.9.2 |
| Database | PostgreSQL 17 (`postgres:17-alpine`; hosted Supabase runs 17.11) |
| Local development | Docker Compose (`db`, `backend`, `frontend`, and a `tools` profile for one-off commands) |
| Deployment | Vercel Services (`nextjs` + `fastapi`), Supabase PostgreSQL over the session-mode pooler |

The brief requires a Next.js + TypeScript frontend and Supabase PostgreSQL in production with
plain PostgreSQL locally; FastAPI is the chosen permitted backend option, and Docker Compose was
selected and is therefore part of the required scope. Authentication is a small custom
opaque-session implementation so that roles, expiry, and revocation stay in the application
schema instead of a third-party identity provider.

## Quick start

Prerequisite: Docker Desktop with Compose v2. Everything else runs in containers, so no local
Node.js or Python installation is needed.

```sh
cp .env.example .env        # replace placeholder passwords locally; never commit .env
docker compose config --quiet
docker compose up -d db
docker compose --profile tools run --rm tools python -m app.bootstrap_local   # roles + schemas
docker compose --profile tools run --rm tools alembic upgrade head
docker compose --profile tools run --rm tools python -m app.seed              # demo accounts + events
docker compose up -d --build backend frontend
curl -i http://localhost:8000/health   # 200 {"status":"ok","database":"connected","schema":"ready"}
open http://localhost:3000/
```

- Frontend: <http://localhost:3000> · API: <http://localhost:8000> · interactive API docs (local
  only): <http://localhost:8000/docs>.
- Demo data: an admin and a user account (`SEED_ADMIN_EMAIL` / `SEED_USER_EMAIL` in `.env`), 12
  upcoming events plus 1 past event, and one normal-user booking that leaves a capacity-2 event
  nearly full. Seed timestamps are relative to seeding time and age — re-run the seed before a
  fresh demo.
- Data persists in the `postgres_data` volume across `docker compose down`;
  `docker compose down --volumes` is a deliberate destructive reset.

## Configuration

[.env.example](.env.example) documents every variable. The important ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Backend runtime connection (restricted runtime role, `postgresql+psycopg://` scheme enforced) |
| `MIGRATION_DATABASE_URL` | Alembic and seed connection (privileged migrator role; tools service only) |
| `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL` | Isolated `eventbook_test` targets; the test suite refuses anything else |
| `SEED_ADMIN_EMAIL`, `SEED_USER_EMAIL` (+ passwords) | Demo accounts created by the seed |
| `APP_ENV`, `ALLOWED_ORIGINS`, `DB_POOL_SIZE`, `DB_CONNECT_TIMEOUT` | Backend runtime settings (exact CORS origins, bounded pool) |
| `LOGIN_RATE_LIMIT_ATTEMPTS`, `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | Failed-login throttle, per client address + account (defaults: 5 failures per 60 s) |
| `EXPECTED_ALEMBIC_REVISION` | Readiness gate for `/health` |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend API base; `/api` in production (inlined at build time) |

Only `NEXT_PUBLIC_*` values reach the browser bundle, so nothing secret has a path into the
frontend. Real `.env` files are gitignored; never commit them.

## Tests

```sh
# Backend: isolated test database (eventbook_test); the suite refuses non-test targets.
docker compose --profile tools run --rm tools pytest -q        # 123 passed

# Frontend
cd frontend
npm test          # 153 tests, 13 files (Vitest + Testing Library)
npm run typecheck # tsc --noEmit
```

- Backend tests run against real PostgreSQL, so constraints, grants, row locks, and concurrency
  behavior are exercised for real rather than through fakes. The bonus race proofs live in
  `backend/tests/test_concurrency.py`: two barrier-fired bookings contend for one remaining seat
  (exactly one 201 and one `EVENT_FULL`, active count stays equal to capacity), and a capacity edit
  racing a booking serializes on the same event row lock so `active <= capacity` always holds.
- Frontend tests cover the typed API client, auth hydration, list/detail/admin/bookings flows,
  and the cache and navigation regressions.

## API

| Area | Endpoints |
| --- | --- |
| Public events | `GET /api/events?q=&page=&page_size=` (upcoming only, literal title search, paginated) · `GET /api/events/{id}` (detail, works for past events too) |
| Auth | `POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` |
| Bookings (signed-in users) | `POST /api/events/{id}/bookings` · `GET /api/bookings/me` · `DELETE /api/bookings/{id}` |
| Admin (`admin` role) | `GET /api/admin/events` · `POST /api/admin/events` · `PATCH /api/admin/events/{id}` · `DELETE /api/admin/events/{id}` · `GET /api/admin/events/{id}/attendees` |
| Operations | `GET /health` and `GET /api/health` — sanitized readiness; `ok` only when the database is reachable and at the expected Alembic revision |

Rules enforced at the API: admins cannot book (`ADMIN_BOOKING_FORBIDDEN`) and manage events
instead; user tokens cannot use admin routes; booking a full, already-booked, or started event is
rejected (`EVENT_FULL`, `ALREADY_BOOKED`, `EVENT_STARTED`); repeated failed logins return
`429 TOO_MANY_ATTEMPTS` with `Retry-After`; errors are sanitized to stable machine-readable codes
without internal detail.

## How it works

All tables live in the private `eventbook` schema:

- **`users`** — uuid primary key, unique normalized email, Argon2id hash, `role` defaulting to
  `user`, with no runtime path that can set `admin`.
- **`sessions`** — user FK (cascade), unique SHA-256 token hash, expiry timestamp.
- **`events`** — nonempty title/description/venue, `total_seats > 0`, UTC start time.
- **`bookings`** — one active booking per (user, event) enforced by a partial unique index; user
  FK restrict, event FK cascade.

`seats_left` is computed per request and never stored. The Alembic version row lives in
`eventbook.alembic_version`; the runtime role can only read it.

Key design decisions:

- **Capacity and the last seat** — there is no stored counter. A booking locks the event row
  (`SELECT … FOR UPDATE`), then counts active bookings in a separate statement, rejects with
  `EVENT_FULL` when the count has reached capacity, and inserts; commits are serialized by the
  lock, so a simultaneous second booker acquires the lock only after the first commit and sees the
  new count. Eligibility and start times are judged with fresh database time after the lock —
  never request-arrival time — and lock/statement timeouts roll back and surface as retryable
  `503`s. Guests and admins share the same lock-first protocol.
- **Deletion** — an event with any active booking cannot be deleted (`EVENT_HAS_BOOKINGS`), and
  started events are read-only (`EVENT_STARTED`), so booking history is preserved rather than
  silently rewritten.
- **Time** — stored in UTC; admin input requires an explicit offset; the UI presents Nepal time
  (UTC+05:45).
- **Auth storage** — tokens travel in an `Authorization: Bearer` header only and are kept in
  `sessionStorage`; the frontend never talks to the database and holds no Supabase client.

See [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) for the full contract behind these
choices.

## Project structure

```
frontend/    Next.js app: app/ routes, components/, lib/ (typed API client, auth, caches)
backend/     FastAPI app: app/ modules, migrations/ (Alembic), tests/ (pytest)
docs/        project brief, requirements, technical design, implementation plan, progress log
compose.yaml local db + backend + frontend services, plus the tools profile
vercel.json  production contract: two Services and the /api/* + /health rewrites
.env.example configuration template for local development (no real secrets)
AGENTS.md    engineering rules used while building: readability, verification, review
```

## Deployment

Production is one Vercel project with two Services (`frontend/` nextjs, `backend/` fastapi)
described by [vercel.json](vercel.json): `/api/*` and `/health` rewrite to FastAPI, everything
else serves Next.js. Services are private unless a rewrite exposes them, so FastAPI's `/docs` is
not a public production route, and the browser calls the API at the same origin — no CORS setup
and no Next.js proxy.

Supabase specifics:

- PostgreSQL 17 with TLS (`sslmode=require`). Use the **session-mode pooler** host; the username
  is `<role>.<project-ref>` (a bare role name fails with "Tenant or user not found"). The direct
  `db.<ref>` host is IPv6-only and unreachable from Vercel functions.
- Keep `DB_POOL_SIZE` small in production (for example 2): Vercel reuses warm instances, and the
  Supabase pooler has a client limit. The runtime role is least-privilege; migrations and seeding
  run from a machine that can reach Supabase with the migrator role.
- Preview deployments must use their own Supabase project or branch — never point Preview at the
  production database. Functions scale to zero, so the first request after idle may cold-start;
  `/health` reports readiness once warm.

Release order: apply migrations first (`alembic upgrade head` with the migrator URL), set the
Vercel Production variables (`NEXT_PUBLIC_API_BASE_URL=/api`, sensitive `DATABASE_URL`,
`APP_ENV=production`, `ALLOWED_ORIGINS`, `EXPECTED_ALEMBIC_REVISION`, `DB_POOL_SIZE`), deploy,
then verify `/health`, both demo logins, and the event list. The hosted database is at
`0002_booking_hard_delete`.

<details>
<summary>One-time hosted provisioning (applied 2026-10-17)</summary>

Run as the Supabase `postgres` role; kept here for reproducibility:

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
-- Supabase's `postgres` is not a superuser: schema ownership changes perform a
-- SET ROLE check that fails unless `postgres` is a member of the migrator role.
GRANT eventbook_migrator TO postgres;
GRANT CONNECT ON DATABASE postgres TO eventbook_migrator, eventbook_runtime;
GRANT CREATE  ON DATABASE postgres TO eventbook_migrator;
-- Alembic stamps its version table before the migration body runs, so the
-- schema shell must pre-exist, owned by the migrator.
CREATE SCHEMA IF NOT EXISTS eventbook AUTHORIZATION eventbook_migrator;
ALTER SCHEMA eventbook OWNER TO eventbook_migrator;
```

Verified after provisioning: Supabase's `anon`, `authenticated`, and `service_role` have no
`eventbook` usage.
</details>

## Known issues and next steps

- The optional brief bonuses are implemented: the simultaneous-last-seat race proof and a
  capacity-edit race live in `backend/tests/test_concurrency.py`, and repeated failed logins are
  throttled (`429 TOO_MANY_ATTEMPTS` with `Retry-After`). Throttling state is in-process, so with
  multiple backend instances it bounds each instance's buckets rather than the whole fleet;
  capacity correctness is row-lock enforced regardless.
- Seed timestamps are relative to seeding time, so the demo dataset ages; re-run the seed for a
  fresh demo (the hosted dataset also drifts as people test).
- Operational surface is intentionally small: sanitized errors and the `/health` readiness
  endpoint; there is no third-party error monitoring.

## How this was built (AI disclosure)

The project was developed by the human developer working with AI coding agents (OpenCode) acting
as the implementation agent, while the human owned product choices, reviews, and acceptance. Each
milestone was checked by an independent reviewer agent before being recorded complete; the git
history shows the increments, and [docs/PROGRESS.md](docs/PROGRESS.md) records the exact commands,
results, corrections, and limitations — distinguishing independently verified evidence from
builder-reported results.
