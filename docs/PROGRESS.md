# EventBook progress — TASK-001 + review corrections

> Scope: TASK-001 foundation and review corrections only. No schema,
> auth, or event work started. Schema creation stays in TASK-002.
> Timestamps below are Nepal Time (NPT, UTC+05:45).

## Task: TASK-001
Status: Yes
Date: 2026-10-15
Changed (corrections included):
- compose.yaml (tools bootstrap/seed inputs; temporary startup note)
- .env.example (EXPECTED_ALEMBIC_REVISION documented)
- README.md (temporary ordering + unverified items noted)
- backend/app/db.py (per-configuration engine cache + clear_engine_cache)
- backend/app/config.py (EXPECTED_ALEMBIC_REVISION, empty-is-unset)
- backend/app/main.py (assembly + route wiring only)
- backend/app/readiness.py (NEW: schema/tables/revision probe, small interface)
- backend/tests/__init__.py
- backend/tests/test_db_isolation.py (4 regression tests)
- backend/tests/test_readiness.py (13 regression tests)
- backend/Dockerfile
- backend/pyproject.toml
- backend/README.md
- backend/app/__init__.py
- backend/app/errors.py
- frontend/Dockerfile
- frontend/.dockerignore
- frontend/package.json (Next 15.5.28)
- frontend/package-lock.json
- frontend/tsconfig.json
- frontend/next.config.ts
- frontend/src/app/layout.tsx
- frontend/src/app/page.tsx
- frontend/src/app/globals.css
- frontend/public/.gitkeep
- docs/PROGRESS.md (this file)
- docs/IMPLEMENTATION_PLAN.md (TASK-001 row Yes)
- .env (local only, ignored; not a deliverable)

Corrections applied:
1. Engine isolation: replaced single-global cache with key
   (DATABASE_URL, pool size, connect timeout). Added
   clear_engine_cache() for tests. Regression test proves dev vs test
   URLs never share an engine.
2. Readiness: /health now requires eventbook schema + all four tables
   (users, sessions, events, bookings) + alembic_version row, with exact
   match when EXPECTED_ALEMBIC_REVISION is set. Anything missing yields
   sanitized 503. Existence of the version table is checked via
   information_schema before any version SELECT, because a failed SELECT
   aborts the PostgreSQL transaction and would poison a fallback query.
   No startup migrations added.
6. Readiness fallback fix: replaced try/except fallback across
   eventbook/public version tables with existence-first lookup
   (preference eventbook, then public). Fakes simulate PG
   aborted-transaction semantics; new tests prove public-only readiness
   and that no version SELECT runs when the table is absent. README
   stale "no tests" corrected to foundation-tests-exist.
7. AGENTS.md compliance pass: moved readiness rules from `main.py` into
   focused `app/readiness.py` (`get_readiness` + expected constants);
   `main.py` keeps assembly/route wiring only. Removed dead code and
   duplication by routing both `/health` and `/api/health` through one
   handler and using the shared `error_response` helper (previously
   unused; envelope construction was duplicated). Accurate return type
   with `response_model=None`. No new abstractions: plain functions and
   modules, no repositories or one-implementation interfaces. `db.py`
   per-config cache retained as-is (keyed, regression-tested; engine
   pooling needs process-wide cache, and keying already prevents
   cross-config mixing).
3. Tools inputs: tools service now receives POSTGRES_DB/TEST_DB, all
   POSTGRES_* role credentials, SEED_* passwords, and revision var.
   Backend keeps runtime-only env; frontend keeps public URL only.
4. Evidence accuracy (see Verification): TCP is network-only, not SQL
   auth; commit hygiene is unverified (no repo).
5. Startup dependency: frontend stays on `service_started` temporarily;
   switch to `service_healthy` is planned after TASK-002 (noted in
   compose.yaml, README, and below).

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose config --quiet` → OK after corrections (11:0x).
- `docker compose build backend` → success with corrected cache/readiness.
- `docker compose --profile tools run --rm tools pytest -q` → `17 passed`
  (4 isolation + 13 readiness/health) after fallback fix and after the
  AGENTS.md refactor (readiness moved to `app.readiness`, single health
  handler, shared error helper). Earlier `14 passed` run is superseded.
  One interim collection error during refactor ( stacked health routes
  need `response_model=None` with a union return annotation) fixed;
  rerun green.
- `docker compose up -d --build backend` (post-fix) → recreated, `curl
  http://localhost:8000/health` → `503
  {"error":{"code":"TEMPORARILY_UNAVAILABLE","message":"Service
  temporarily unavailable."}}`; frontend → `200`. Same sanitized envelope.
- `docker compose exec -T db psql -U eventbook_bootstrap -d
  eventbook_dev -c "SELECT 1"` → `1` (1 row). Proves PostgreSQL accepts
  bootstrap SQL only; does not prove backend runtime SQL auth.
- Backend runtime SQL auth: NOT verified. `eventbook_runtime` role does
  not exist until TASK-002, so backend 503 reflects missing role and
  missing schema. Earlier TCP `db:5432 ok` is recorded as network
  reachability only, not authenticated access. Correction of prior claim.
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` →
  `200`; body contains EventBook title/copy.
- `curl -H "Origin: http://localhost:3000" .../health` →
  `access-control-allow-origin: http://localhost:3000`.
- Secret isolation (not commit verification):
  `git status` → `fatal: not a git repository`. No commit check possible.
  Ignore-rule checks: `.gitignore` lines 2-4 ignore `.env`;
  `ls -la .env .env.example` → both present, `.env` local-only.
  `grep -R DATABASE_URL|BOOTSTRAP|SEED_*_PASSWORD frontend/src` → clean.
  Frontend runtime env → only `NEXT_PUBLIC_API_BASE_URL`.
  Backend env keys → runtime-only (no bootstrap/migration/test/seed
  passwords). Tools env keys → full privileged set present (and only there).
  Health body + backend logs contain no `changeme-` placeholder.
- Persistence: `postgres_data`, `frontend_node_modules`,
  `frontend_next` volumes retained across `down`/`up`; db healthy,
  frontend 200, backend 503 after restart (verified pre-correction,
  unchanged by corrections).

Decisions:
- Postgres `postgres:17-alpine` (running 17.11), provisional; reconcile at TASK-007.
- Next.js `15.5.28` (CVE-2025-66478 patch), React 19.1.0, TS 5.6.3,
  Node `22-alpine`, Python `3.12-slim`.
- Readiness version table: check `eventbook.alembic_version`, fallback to
  `public.alembic_version`; TASK-002 sets final placement/revision with a
  justified update if it differs.
- Frontend ordering: TEMPORARY `service_started` (TASK-001, backend 503
  expected). PLANNED: `service_healthy` after TASK-002 when /health is 200.

Verification vs user request:
- [x] Frontend opens — 200 verified.
- [x] Backend health responds — 503 sanitized verified (expected pre-migration).
- [ ] Backend authenticated SQL access — NOT verified; runtime role +
  schema are TASK-002. Only bootstrap SQL + sanitized 503 proven.
- [ ] No secrets committed — NOT verifiable; no git repo. Isolation
  checks above pass; commit check deferred until after `git init`.

Implemented (verified): Compose services + tools inputs, Dockerfiles, env
examples, CORS, bounded pool, per-config engines, error envelope,
schema+tables+revision readiness (existence-first, abort-safe), persistent
volumes, tools profile, regression tests (17 passed), README setup docs.

Unverified / deferred (not claimed):
- Authenticated backend SQL with runtime role (needs TASK-002 roles).
- Commit hygiene (`git status` clean) — no repo yet.
- Edit-triggered hot-reload observation; production `next build`;
  any migration/seed/auth/event/booking/admin/deployment (TASK-002+).

Remaining: none for TASK-001 corrections. Runtime roles + schema are
TASK-002 dependencies.
Next: stop for review. Do not start TASK-002 without instruction.

Blockers:
- Docker daemon was initially stopped; resolved via Docker Desktop launch.
- `eventbook_runtime` (and migrator/test roles) do not exist yet.
  Expected; provisioning is TASK-002. Backend 503 until then.

---

## Task: TASK-002
Status: Yes
Date: 2026-10-15
Changed:
- backend/pyproject.toml (alembic 1.14.1, argon2-cffi 23.1.0, version 0.2.0)
- backend/Dockerfile (copies alembic.ini + migrations for tools/prod)
- backend/alembic.ini (explicit MIGRATION_DATABASE_URL via env.py)
- backend/migrations/env.py (version_table_schema=eventbook)
- backend/migrations/versions/0001_initial.py (revision 0001_initial)
- backend/app/models.py (NEW: four tables, checks, FKs, partial-unique index)
- backend/app/passwords.py (NEW: Argon2id hash/verify for seed + TASK-003)
- backend/app/bootstrap_local.py (NEW: idempotent roles/DBs/CONNECT grants)
- backend/app/seed.py (NEW: repeatable 13-event + 2-account seed)
- backend/app/db.py (shared engine_from_url construction site)
- backend/app/config.py (revision comment now names 0001_initial)
- backend/tests/conftest.py (NEW: test-target guard, migrate, truncate)
- backend/tests/test_database.py (NEW: 8 constraint/grant/isolation tests)
- backend/tests/test_passwords.py (NEW: 4 helper unit tests)
- compose.yaml (frontend now waits for healthy backend)
- .env.example + .env (EXPECTED_ALEMBIC_REVISION=0001_initial)
- README.md (TASK-002 setup, tables, demo logins, grants)
- docs/IMPLEMENTATION_PLAN.md (TASK-002 row Yes)
- docs/PROGRESS.md (this entry)

Decisions (with reasons):
- Alembic version row in `eventbook.alembic_version`, not public: the
  migrator has no CREATE on `public` (first upgrade failed with
  InsufficientPrivilege there). Runtime holds SELECT on that row only;
  default privileges would otherwise grant it row writes.
- Bootstrap creates the empty `eventbook` schema AUTHORIZATION migrator:
  Alembic stamps its version row before the migration body runs, so the
  schema must pre-exist. Tables and grants stay in the migration.
- Users INSERT grant is column-restricted `(id, email, password_hash)` and
  UPDATE on `users` is withheld entirely, so the runtime cannot promote
  itself; omission inserts receive the `'user'` server default (verified
  by test). Bookings UPDATE is restricted to `(cancelled_at)`.
- Seed refuses the test database by name; reruns insert missing rows only.
- `require_test_urls()` fails fast on any non-`eventbook_test` target
  (Review Focus #5); conftest migrates the test DB with
  `EVENTBOOK_RUNTIME_ROLE` pointed at the test runtime role.
- Extra `test_passwords.py` beyond the plan's file list: the new
  passwords module needs coverage in the same one-command suite.

Evidence (actual runs, 2026-10-15 NPT):
- Red during work (fixed, not claimed as passing): `CREATE ROLE ...
  PASSWORD $1` rejected (utility statements take no bind params; fixed
  with Literal quoting); first `alembic upgrade head` denied on
  `public.alembic_version` (moved version table into eventbook).
- `python -m app.bootstrap_local` → 4 roles created, 1 DB created +
  1 kept, both DBs isolated, hosted roles absent-skipped. Rerun →
  all kept (idempotent, passwords untouched).
- `alembic upgrade head` (dev) → 5 relations owned by migrator,
  version `0001_initial`; `alembic_version` grants: migrator full,
  runtime SELECT only.
- `python -m app.seed` run 1 → 2 users / 13 events / 1 booking;
  run 2 → 0/0/0; third run after hash capture → admin hash identical
  (no silent credential reset). Roles admin/user, hashes `$argon2id$`.
- `docker compose --profile tools run --rm tools pytest -q` →
  `29 passed` (4 isolation + 13 readiness/health + 4 passwords +
  8 database), including wrong-target refusal and cross-DB denial.
- Backend recreated with revision env → `/health` and `/api/health`
  → `200 {"status":"ok","database":"connected","schema":"ready"}`;
  container `healthy`. First verified authenticated runtime SQL access.
- Hot reload: `touch backend/app/main.py` → uvicorn restart, health
  stays 200; `touch frontend/src/app/page.tsx` + request → Next
  `Compiled` and 200.
- `docker compose down` → `up -d db backend frontend` → counts
  `2/13/1` preserved; db/backend/frontend all healthy.
- `compose.yaml` frontend switched to `service_healthy` as planned;
  `docker compose up -d frontend` shows backend Healthy gate, page 200.
- Secret hygiene: frontend env still public-URL-only; backend
  runtime-only; privileged URLs/passwords in tools only. No hashes or
  passwords in responses/logs (checked bodies + `changeme-` grep).

Verification vs plan gate:
- [x] Duplicate active booking blocked, rebooking after cancel allowed
  (constraint level, real PostgreSQL).
- [x] FK/CHECK enforced (bad event FK, zero seats, bad role, raw email).
- [x] Runtime cannot self-promote (UPDATE/INSERT-role denied, omission
  defaults to user); cannot CREATE tables; PUBLIC has no USAGE.
- [x] Test/dev CONNECT isolation both directions; wrong test target
  refused before destructive ops.
- [x] Seed repeatable (0/0/0 rerun, stable hashes); 13 events exercise
  pagination; capacity-2 event holds 1 admin booking.
- [x] One-command suite green; live readiness 200; persistence proven.

Implemented (verified above): models, migration + grants, bootstrap,
seed, password helper, isolated harness + 12 new tests, healthy
readiness, reload, persistence, ordering switch, docs.

Unverified / deferred (not claimed):
- Auth/session endpoints and booking/admin behavior (TASK-003+).
- Seed timestamp ageing: relative dates go stale; refresh demo data
  explicitly before submission.
- Commit hygiene — still no git repo.
- Deployment/Supabase wiring (TASK-007).

Remaining: none for TASK-002.
Next: stop for review. Do not start TASK-003 without instruction.

---

## Task: TASK-002 review fixes
Status: Yes
Date: 2026-10-15
Changed:
- backend/tests/conftest.py (fixed test target + live destination/role check)
- backend/app/seed.py (event-locked booking ensure + fixed test refusal)
- backend/migrations/versions/0001_initial.py (explicit frozen DDL)
- backend/app/models.py (frozen-history note only)
- backend/tests/test_database.py (7 new regression tests)
- docs/PROGRESS.md (this entry)

1. Fixed isolated test target: `FIXED_TEST_DATABASE`,
   `FIXED_TEST_MIGRATION_ROLE`, `FIXED_TEST_RUNTIME_ROLE` constants.
   `require_test_urls()` matches parsed name and username against them;
   the `POSTGRES_TEST_DB` override is ignored. New
   `validate_live_test_target()` connects to each URL and asserts
   `current_database()`/`current_user()` before migrate/cleanup.
   `_alembic_upgrade` grants to the fixed test runtime role.
2. Seed booking under lock: new `_ensure_admin_booking()` locks the event
   (`FOR UPDATE`), re-checks DB wall-clock time, duplicate, and active
   count, then inserts only with capacity. Full/past/missing outcomes
   are reported as `bookings_skipped`, cancelled history never touched.
3. Frozen migration: `Base.metadata.create_all` replaced with explicit
   `op.create_table`/`op.create_index` definitions; the models import is
   gone. Downgrade drops app tables only (the version row must survive
   for Alembic bookkeeping). Upgrade resets stale default privileges
   first: the suite caught recreated tables inheriting full row access
   (runtime UPDATE on users) from a previous run's entries.

Evidence (actual runs, 2026-10-15 NPT):
- Fresh-cycle proof: `alembic downgrade base` + `pytest` on the test DB,
  twice. First fresh run exposed the stale-default-privileges widening
  (`test_runtime_cannot_self_promote` failed); after the reset step both
  cycles green: `36 passed` (29 + 7 new: spoofed-name refusal,
  override-ignored, live accept/refuse, seed full/past/once,
  migration-models match).
- `python -m app.seed` on dev with the locked path → all zeros
  (present, no skip); dev counts intact (2 users / 13 events);
  `/health` still 200.
- `docker compose config --quiet` OK; no dev data touched by any
  destructive step (all downgrades used the test migration URL).

Remaining: none for these fixes.
Next: stop for review. Do not start TASK-003 without instruction.

---

## Task: TASK-003
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/auth.py (NEW: opaque sessions, actor/deps, 4 routes)
- backend/app/errors.py (ApiError + 422 normalization handlers)
- backend/app/main.py (settings on app.state, router, handlers)
- backend/tests/test_auth.py (NEW: 12 lifecycle tests)
- README.md (auth endpoints noted)
- docs/IMPLEMENTATION_PLAN.md (TASK-003 row Yes)
- docs/PROGRESS.md (this entry)

Decisions (with reasons):
- `UserActor` frozen dataclass of plain values: auth closes its own
  read before returning, so later write transactions start clean and no
  ORM object can trigger lazy queries inside them.
- `extra="forbid"` + email shape validator: `role`/unknown fields and
  malformed input fail as 422 `VALIDATION_ERROR` with field messages;
  submitted passwords never echoed (asserted in tests).
- Duplicate-email detection checks `sqlstate 23505` then confirms the
  email row, so a UUID collision could never misreport `EMAIL_EXISTS`.
- Unknown-email logins run a dummy Argon2id verify, keeping the
  invalid-login response identical either way (asserted byte-equal).
- Unknown routes keep framework defaults (no catch-all handler), so the
  404 contract is untouched; only `ApiError` and validation failures
  render the shared envelope.

Evidence (actual runs, 2026-10-15 NPT):
- Two genuine reds fixed, both behavior-level: psycopg3 reports
  `sqlstate`, not `pgcode` (409 path never taken until fixed), and the
  expiry fixture violated `ck_sessions_expiry` (now backdates both
  timestamps, preserving the CHECK).
- `docker compose --profile tools run --rm tools pytest -q` →
  `48 passed` (36 + 12 auth: lifecycle, normalization, 409, 422
  sanitization, Argon2id storage, generic 401, hashed-once token,
  expiry, logout, challenge headers, fresh role reads, admin dep).
- Live smoke on `localhost:8000` (disposable user, row deleted after):
  register 201 → 43-char token → `/me` 200 → logout 204 →
  `/me` 401 `INVALID_SESSION`; backend logs grep clean of the
  address and password; session row cascaded on user delete.
- `docker compose config --quiet` OK; `/health` 200; frontend 200.

Limitations:
- No rate limiting (deferred bonus); no frontend auth UI (TASK-007/008).
- Token expiry relies on DB `now()`; no refresh endpoint by design.

Remaining: none for TASK-003.
Next: stop for review. Do not start TASK-004 without instruction.

---

## Task: TASK-003 review fixes
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/auth.py (non-ASCII token → 401; no-store on login/me)
- backend/app/errors.py (shared 503 database-error handler)
- backend/app/main.py (SQLAlchemyError handler wiring)
- backend/tests/test_auth.py (3 new regression tests)
- docs/PROGRESS.md (this entry)

1. Malformed bearer token: `_hash_token` encoded ASCII strictly, so a
   non-ASCII header value raised `UnicodeEncodeError` into a 500.
   `get_current_user` now maps it to a controlled 401 `INVALID_SESSION`
   with the bearer challenge; such bytes can never match an issued
   URL-safe token.
2. Database failure handling: `SQLAlchemyError` now renders the shared
   503 `TEMPORARILY_UNAVAILABLE` envelope (details server-side only).
   In-route `IntegrityError` translation (duplicate email → 409) runs
   first, so the 409 path is unaffected.
3. Private-response caching: `login` and `/me` set
   `Cache-Control: no-store` via the injected response object.

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose --profile tools run --rm tools pytest -q` →
  `51 passed` (48 + 3 new: raw-bytes non-ASCII bearer → 401 envelope;
  dead-DB login and `/me` → 503 JSON envelope with JSON content-type;
  login and `/me` carry `no-store`). The non-ASCII case initially
  failed client-side (httpx rejects non-ASCII str headers), so the
  test sends raw latin-1 header bytes as a real client would.
- Live on `localhost:8000` after rebuild: login returns
  `cache-control: no-store`; non-ASCII bearer → 401 `INVALID_SESSION`;
  `/health` 200. Smoke session row deleted after (dev data unchanged);
  backend logs contain no credential material.
- `docker compose config --quiet` OK.

Remaining: none for these fixes.
Next: stop for review. Do not start TASK-004 without instruction.

---

## Task: TASK-003 recheck fixes
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/errors.py (DB handler logs class name only)
- backend/app/main.py (app-level no-store middleware for /api/auth*)
- backend/app/auth.py (per-route no-store removed as redundant)
- backend/migrations/env.py (fileConfig no longer mutes app loggers)
- backend/tests/test_auth.py (3 new regression tests)
- docs/PROGRESS.md (this entry)

1. Sensitive database logging: `database_error_handler` used
   `log.exception`, and SQLAlchemy error text carries the statement plus
   bound parameters, so emails/hashes/tokens reached logs. The handler
   now logs only the exception class name; envelope unchanged.
2. Cache protection: `login`/`/me` set the header per-route while error
   responses and logout bypassed it. An app-level middleware now marks
   every `/api/auth*` response `no-store` (success, 401/403/409/422,
   204, 503); the redundant per-route sets were removed. Non-auth
   paths (e.g. `/health`) are untouched.

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose --profile tools run --rm tools pytest -q` →
  `54 passed` (51 + 3 new: handler unit test pins a synthetic marker
  absent from logs with the class name present; error-path/logout/
  outage responses all carry `no-store`).
- Suite debugging found and fixed a real harness interaction: Alembic
  `fileConfig` disables existing loggers in-process, which muted the
  app logger for later tests and hid log output from `caplog`. The
  migration env no longer disables existing loggers.
- Live after rebuild: login returns `cache-control: no-store`,
  non-ASCII bearer → 401 envelope, `/health` 200 without the header,
  smoke session deleted, backend logs free of credential material.
- `docker compose config --quiet` OK.

Remaining: none for these fixes.
Next: stop for review. Do not start TASK-004 without instruction.

---

## Task: TASK-004
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/events.py (NEW: list/detail, seats aggregate, LIKE escaping)
- backend/app/pagination.py (NEW: shared page bounds + envelope)
- backend/app/errors.py (ApiError fields; clean query/path field names)
- backend/app/main.py (events router wiring)
- backend/tests/test_events.py (NEW: 6 API tests)
- README.md (public browsing noted)
- docs/IMPLEMENTATION_PLAN.md (TASK-004 row Yes)
- docs/PROGRESS.md (this entry)

Decisions (with reasons):
- `ApiError` gained optional `fields` so query validation (`page`,
  `page_size`, `q`) reports field errors inside the shared envelope;
  the validation handler now strips `query`/`path` loc prefixes for
  clean field names (`page`, not `query.page`).
- Count and items run under one `REPEATABLE READ` transaction with
  identical filters (SET TRANSACTION first, per the auth-txn warning);
  seats come from a single `LEFT JOIN` aggregate, never per-event
  queries. Detail is one grouped statement; past detail allowed.
- `pagination.parse_pagination`/`envelope` are shared for TASK-005/006
  collections; no other abstraction added.

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose --profile tools run --rm tools pytest -q` →
  `60 passed` (54 + 6 events: upcoming/past-detail, active-only seats,
  case-insensitive + literal `%`/`_`/backslash with decoys, page
  boundaries/empty/out-of-range/bounds, ordering/envelope shapes,
  404/invalid-UUID). Green on first full run; no test required a fix.
- SQL inspection (echo on one listing): `SET TRANSACTION ISOLATION
  LEVEL REPEATABLE READ` → filtered `count(*)` → one grouped
  `LEFT JOIN` select with `LIMIT/OFFSET`; identical `WHERE`
  (`starts_at > now()`, escaped `ILIKE ... ESCAPE '\'`). No N+1.
- Live on seeded dev: `total: 12` upcoming of 13, page1 10 items,
  page2 2 items, title search 1 hit, nearly-full event shows
  `seats_left: 1`. `/health` 200, frontend 200, logs clean.
- `docker compose config --quiet` OK.

Limitations:
- No authenticated booking/admin behavior (TASK-005/006); listing has
  no auth and correctly requires none.
- `q` matches title only, per the brief; no search extension.

Remaining: none for TASK-004.
Next: stop for review. Do not start booking features or TASK-005.

---

## Task: TASK-004 review fixes
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/events.py (offset guard; NUL rejection)
- backend/tests/test_events.py (2 new regression tests)
- docs/PROGRESS.md (this entry)

1. Extreme page overflow: `OFFSET` beyond PostgreSQL's range errored
   into a 503. After the (offset-free) count, an `offset >= total`
   listing now skips the select and returns the empty collection the
   contract requires; in-range pages are untouched.
2. NUL search: PostgreSQL rejects NUL bytes, which also surfaced as a
   503. `_parse_search` rejects any `q` containing NUL with a 422
   field error before any query runs.

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose --profile tools run --rm tools pytest -q` →
  `62 passed` (60 + 2 new: `page=10**12` with default and max sizes →
  200 empty with correct total; embedded and lone NUL → 422 with
  `fields.q`).
- Live: `page=1000000000000` → 200 empty (`total: 12`); raw `%00`
  query → 422 `VALIDATION_ERROR` envelope. (Shell `curl` cannot send
  NUL bytes — bash strips them — so the live NUL check used Python
  urllib.)
- `docker compose config --quiet` OK.

Remaining: none for these fixes.
Next: stop for review. Do not start TASK-005.

---

## Task: TASK-005
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/bookings.py (NEW: lock-first book/history/cancel + routes)
- backend/app/events.py (`utc_z` shared for nested event shapes)
- backend/app/main.py (bookings router; no-store extended to /api/bookings)
- backend/tests/test_bookings.py (NEW: 11 B1–B4 rule tests)
- backend/tests/test_concurrency.py (NEW: 2 protocol tests)
- README.md (booking endpoints noted)
- docs/IMPLEMENTATION_PLAN.md (TASK-005 row Yes)
- docs/PROGRESS.md (this entry)

Decisions (with reasons):
- Module owns whole transactions: lock event → fresh `clock_timestamp()`
  → duplicate/capacity checks → mutate → commit; success returned only
  from committed rows re-read after commit. Auth reads stay closed
  before module transactions begin.
- Cancel locates the event via an unlocked actor-scoped read, then locks
  the event before re-reading booking, time, and writing; another
  user's id returns the same 404 as a missing row. Past cancel fails
  even when repeated; future repeat is a 204 no-op.
- `SET LOCAL lock_timeout 5s` / `statement_timeout 10s` open every write
  txn; timeouts roll back then map to retryable 503, and commit-time
  unique races map to 409 after rollback. Private booking payloads are
  `no-store` (middleware for `/api/bookings*`, explicit line for the
  POST under the public `/api/events` prefix).
- Lock-wait and timeout tests live in `test_concurrency.py`; the
  bonus last-seat race proof stays reserved for TASK-009 and is not
  claimed here.

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose --profile tools run --rm tools pytest -q` →
  `75 passed` (62 + 11 bookings + 2 protocol). One test bug fixed
  (mine, not code: unauthenticated bounds check hit 401 before
  pagination validation, correctly — test now authenticates it).
- Protocol tests use real row locks across two connections with bounded
  waits: lock-held start-time crossing → 409 with zero rows; 5s lock
  wait → 503 with zero rows (~11s suite).
- Live cycle on seeded dev (disposable users, rows deleted after):
  201 (seats 50→49) → second-user 201 → cancel 204 → history total 1;
  private responses carry lowercase `no-store` (an early `None` reading
  was my script's case-sensitive dict lookup, not the server).
  Dev data restored, logs clean.
- `docker compose config --quiet` OK; `/health` 200; frontend 200.

Limitations:
- No admin event management (TASK-006); no last-seat race demo (bonus).
- History pages with `page_size` bounds unchanged (1–50 shared helper).

Remaining: none for TASK-005.
Next: stop for review. Do not start admin features or TASK-006.

---

## Task: TASK-006
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/admin.py (NEW: CRUD, attendees, B5/policy enforcement)
- backend/app/events.py (shared search_events/parse helpers)
- backend/app/bookings.py (shared write_event helper; book/cancel reuse it)
- backend/app/main.py (admin router; no-store extended to /api/admin)
- backend/tests/test_admin.py (NEW: 18 API tests)
- README.md (admin endpoints + capacity/deletion/time trade-offs)
- docs/IMPLEMENTATION_PLAN.md (TASK-006 row Yes)
- docs/PROGRESS.md (this entry)

Decisions (with reasons):
- `search_events(engine, upcoming_only=...)` extracted in events.py so
  the admin list reuses the public listing's filters, counts, ordering,
  envelope, and offset guard; public behavior unchanged (its tests green).
- `write_event(engine, event_id)` context manager in bookings.py owns
  the lock-first/timeout/fresh-time protocol; book, cancel, admin edit,
  and admin delete all run on it. No divergent locking logic remains.
- Validation via Pydantic (`extra="forbid"`, trimmed strings,
  `AwareDatetime` rejects naive input, `StrictInt` 1–100000) plus
  explicit null/empty-PATCH 422s; unknown routes keep framework defaults.
- Deletion rejects on ANY active booking (no time check, past included)
  and otherwise deletes with cancelled history cascading via the FK;
  attendees are active-only with identity-minimal shapes.

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose --profile tools run --rm tools pytest -q` →
  `94 passed` (76 + 18 admin: per-route 401/403, 12-case input matrix,
  immediate public visibility, past-inclusive list/search, capacity
  below/equal with unchanged-state proof, attendee privacy/shape/order,
  deletion active/past/cascade proofs, edit-to-past, empty/null PATCH,
  serialization, no-store headers, patch validation, bounds matrix,
  UUID probes, past capacity edit, attendee format). Green first full
  run except one test-side mistake (expected 422 for `q` bounds on the
  attendees route, which takes no `q` — extra query args are ignored
  by FastAPI routing by design, not a bug; test rescoped).
- Live cycle on seeded dev (admin session cleaned after): login 200 →
  create 201 (trimmed, Z time) → patch cap 200 → attendees 200 empty →
  public visibility → anon 401 → delete 204 with no bookings; logs clean.
- `docker compose config --quiet` OK; `/health` 200; frontend 200.

Limitations:
- Edit-vs-book concurrency demo reserved for TASK-009 bonus.
- Admin lock-timeout 503 has no dedicated test; the shared helper is
  timeout-covered via bookings protocol tests.
- No frontend admin UI (TASK-007/008); no deployment (TASK-007).

Remaining: none for TASK-006.
Next: stop for review. Do not start TASK-007.

---

## Task: TASK-006 review fixes
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/admin.py (`_string_timestamp` + `_NUMERIC_RE`; NUL in `_trimmed`)
- backend/tests/test_admin.py (epoch/NUL create+patch test)
- docs/PROGRESS.md (this entry)

1. Timestamps: `AwareDatetime` coerced epoch numbers and numeric
   strings, so a before-validator now requires a non-numeric string;
   naive strings still fail downstream. One iteration needed: numeric
   strings first slipped through Pydantic coercion and were caught by
   the new test before the fix landed.
2. NUL text: the shared trim validator rejects NUL in title,
   description, and venue on both models, matching the search-`q`
   convention, before PostgreSQL is touched.

Recheck (same reviewer session `ses_ec1592ea6ffeX3lksPxipEQN6A`):
admin suite `19 passed`; new test `1 passed`; read-only live health
200 and admin 401. Verdict: both fixes CONFIRMED with evidence; no new
blocking findings (two informational minors: scientific-notation
strings still 422 via the downstream path; direct-Python datetimes
rejected, irrelevant to the JSON contract).
Evidence: full suite `95 passed`; `docker compose config --quiet` OK.

Remaining: none for these fixes.
Next: stop for review. Do not start TASK-007.

---

## Task: TASK-007 (preparation complete; deployment blocked)
Status: Blocked (external access missing; all preparable work verified)
Date: 2026-10-15
Changed:
- frontend/src/lib/api.ts (NEW: typed client, header-only tokens)
- frontend/src/lib/auth.tsx (NEW: session provider, hydration, expiry)
- frontend/src/app/page.tsx (real listing: search/pages/states)
- frontend/src/app/login/page.tsx + register/page.tsx (NEW: forms)
- frontend/src/app/layout.tsx (AuthProvider)
- backend/Dockerfile + frontend/Dockerfile (dev/prod stages)
- compose.yaml (build targets pinned to dev)
- .env.example (production notes) + README.md (slice + release runbook)
- docs/IMPLEMENTATION_PLAN.md (TASK-007 row Blocked, prep boxes checked)
- docs/PROGRESS.md (this entry)

Prepared and locally verified:
- `npm run typecheck` clean; `docker build --target prod` succeeds for
  both images (6/6 Next routes prerendered).
- Prod containers run: backend-prod `/health` 200 without reload
  (single worker); frontend-prod serves 200.
- Real-browser prod+prod check: listing renders 10/12 with correct
  seats; login as seeded user → signed-in redirect; reload keeps the
  session (hydration validation); logout returns to signed-out state.
  First attempt caught a genuine CORS gap (prod origin not allowed);
  after aligning origins the flow passed. Smoke session revoked by
  logout; dev data unchanged; backend logs clean.
- `NEXT_PUBLIC_API_BASE_URL` proven baked per-image: custom
  `--build-arg` value found in served chunks; default build bakes the
  local fallback. Fixing the arg path exposed a real bug: an unset ARG
  bakes an empty string, which `??` does not fall back from — changed
  to `||` plus a Dockerfile default so plain builds keep working.
- Backend suite untouched by this task; last full run `95 passed`.

Review (independent subagent `ses_ec13a2b9bffeWMyahJogZ8RnT9`, read-only
plus typecheck/config/curl): no BLOCKING findings; 7 minors. Fixed:
mid-tab 401 now clears the session with the expiry banner
(`markSessionExpired`; listing is public so the path arms with
TASK-008 actions), friendly error map shared with login/register
pages, frontend build-arg wiring, `.dockerignore` `.env*`, stale
README header and NOT-done bullets. Accepted with reasons: stale-query
guard (explicit TASK-008 item), editable-install prod image (works;
noted), prod images built+run by builder after review (reviewer was
barred from slow builds). No recheck requested: no blockers, and
post-review changes are frontend-only additions the reviewer already
structurally approved. Re-verified after fixes: typecheck clean,
default + arg prod builds serve 200 with correct baked URLs, dev
listing intact in-browser.

Deployed: nothing (no access). Verified live: nothing external.
Missing inputs (all absent — no CLIs, env, accounts, or project found):
Supabase project (URL, DB password, session pooler URL), frontend and
backend hosting accounts, GitHub repo + evaluator access, and human
authorization per external step. Release runbook with exact order and
Supabase checklist is in README Deployment; one authorized release
action remains once access exists.

Limitations:
- Deployment gate unsatisfied: a local build never counts, so TASK-007
  stays Blocked, not complete. TASK-008 local work may proceed.
- Booking/admin frontend flows, detail page, Nepal-time handling, and
  lost-response/stale-query guards belong to TASK-008.
- Cold-start/sleep behavior unknown until a host is chosen.

Remaining: external access + one release action (human-owned).
Next: stop for review. Do not start TASK-008.

---

## Task: TASK-006 milestone review (independent subagent)
Reviewer: fresh `general` subagent, session `ses_ec1592ea6ffeX3lksPxipEQN6A`
Date: 2026-10-15
Scope: admin.py routes/B5-B6/policy, shared write_event/search_events,
grants/timeouts, test_admin.py (11 tests at review time), no-store on
admin paths. Read-only except the isolated pytest suite; no dev writes
(reviewer ran no POST/PATCH/DELETE against dev).

Independently verified (reviewer ran): full suite `87 passed`;
per-route 401/403 on all 5 admin routes; 12-case input matrix with
unchanged total; immediate public visibility; past-inclusive list vs
upcoming-only public; capacity below rejected with state proof, equal
allowed; attendee active-only/minimal-shape/ordered/paginated; deletion
blocked with active (incl. past) and cascaded after cancel (0/0 rows);
edit-to-past blocks booking; empty/null PATCH 422; serialization shape.
Live read-only: admin 401 carries `no-store`, public list does not.
Code-verified: require_admin before any I/O on every route; validation
bounds/trim/naive-rejection/StrictInt; lock-first + timeouts via shared
helper with rollback on rejection; cascade works under runtime without
child DELETE privilege; attendee query selects id/email only.

Findings — none BLOCKING. Ten MINOR coverage gaps (code read correct):
no-store asserts, PATCH unknown/naive/trim cases, remaining bounds
(desc 5001, venue 301/blank, bool seats), admin pagination/q bounds,
non-admin UUID probes, B5 on past events, attendee Z/tie-break,
admin timeout-503 test, plus known deferred items (last-seat race for
TASK-009, DELETE-nonexistent, past repeat-cancel, exact-now equality).

Corrections after review (builder, tests only — production code is
exactly what was reviewed): 7 more test functions covering MINOR-1–9
(headers, patch validation, bounds matrix, pagination/q bounds with
the FastAPI extra-query-args note, UUID probes, past capacity edit,
attendee format). MINOR-10 (dedicated admin timeout test) accepted as
covered: identical shared helper already timeout-tested via bookings.
Suite after corrections: `94 passed`. No recheck requested: no
blocking findings existed, and no production code changed since the
reviewed state.

Review limits: single suite run; no live writes/dev mutation; no file
edits by reviewer; auth internals, frontend, deployment, and
concurrent last-seat safety beyond inspection out of scope.
Outcome: TASK-006 accepted with recorded minors; no unresolved
blockers. Human/team-lead review still required per AGENTS.md.

---

## Task: TASK-005 review fixes
Status: Yes
Date: 2026-10-15
Changed:
- backend/app/bookings.py (redundant explicit no-store removed)
- backend/app/main.py (no-store predicate covers booking POST errors)
- backend/tests/test_concurrency.py (natural start-crossing clock test)
- backend/tests/test_bookings.py (booking error no-store test)
- docs/PROGRESS.md (this entry)

1. Clock regression: the old test preset the event an hour past, which
   a stale transaction-start timestamp also rejects. The rewritten test
   starts the event ~2s out and holds the row lock ~3s, so the start
   time passes mid-wait: only a fresh post-lock clock reading rejects.
   Proven discriminating by temporarily restoring `now()`: the test
   fails (booking wrongly accepted); with `clock_timestamp()` it passes.
2. Booking error caching: only the success path carried `no-store`
   (and only via a per-route line the middleware could not see for
   errors). The middleware predicate now also matches
   `POST /api/events/*/bookings`, covering 401/404/409 identically;
   the redundant per-route line was removed.

Evidence (actual runs, 2026-10-15 NPT):
- `docker compose --profile tools run --rm tools pytest -q` →
  `76 passed` (75 + 1 new error-cache test; clock test rewritten).
- Live: unauthenticated booking POST → 401 with `no-store`;
  `/health` 200.
- `docker compose config --quiet` OK.

Remaining: none for these fixes.
Next: stop for review. Do not start TASK-006.

---

## Task: TASK-005 milestone review (independent subagent)
Reviewer: fresh `general` subagent, session `ses_ec163d443ffeg6Dlm9vAu03dlb`
Date: 2026-10-15
Scope: bookings.py routes/B1–B4/protocol, cache middleware predicate,
grants/timeouts, test_bookings.py, test_concurrency.py. Read-only except
the isolated pytest suite; no dev writes (reviewer ran no POST/DELETE
against dev, verified dev `total:12` intact afterward).

Independently verified (reviewer ran): full suite `76 passed in 12.71s`;
live read-only `/health` 200 and public listing shape; B1–B4 trace to
HTTP tests with post-rejection DB-state asserts; grant/code match
(users column-INSERT, bookings UPDATE(cancelled_at) only); timeouts set
first in each write txn; cache predicate covers POST 201/401/404/409
through the shared middleware.
Taken as claims only (not re-run): builder's `now()`-mutation proof,
live booking cycle, prior PROGRESS evidence.

Findings — none BLOCKING (no demonstrated correctness, security, or
acceptance failure):
- MINOR-1: clock test has ~1s unsynchronized margins; cancel-side
  crossing untested. Recorded as accepted limitation; code correct.
- MINOR-2: error `no-store` proven for 3 of ~8 private paths → FIXED
  below (EVENT_FULL/EVENT_STARTED/DELETE paths now asserted).
- MINOR-3: known untested modes — last-seat race (reserved TASK-009
  bonus), DELETE-nonexistent 404, past repeated-cancel 409, exact
  `starts_at == now()` equality, statement-timeout 503. Recorded;
  equality/timeout paths share the verified clock/timeout machinery.
- MINOR-4: 23505 backstop ignored constraint name → FIXED below
  (requires `uq_bookings_user_event_active` when diagnostics report
  one, mirroring the register path).
- MINOR-5: trailing-slash `POST .../bookings/` misses the predicate;
  route returns 307/404 without private data — no action.

Corrections after review (builder):
- backend/app/bookings.py (`_constraint_name` + guarded mapping).
- backend/tests/test_bookings.py (extended error-cache assertions).
- Suite: `76 passed` after corrections (extended in place, count
  unchanged). No recheck requested: no blocking findings existed to
  re-verify, and corrections are additive test/code tightening inside
  the reviewed milestone.

Review limits: single suite run (no flakiness loop); live writes,
`now()`-mutation, auth internals, admin/frontend/deployment, and
concurrent last-seat safety beyond code inspection were out of scope.
Outcome: TASK-005 accepted with recorded minors; no unresolved
blockers. Human/team-lead review still required per AGENTS.md.
