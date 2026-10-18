---
goal: Build and verify EventBook for live submission
version: "1.0"
date_created: 2026-10-15
last_updated: 2026-10-15
owner: Human developer and implementation agent
status: Planned
tags: [feature, fastapi, nextjs, postgres, docker-compose]
---

# EventBook Implementation Plan

> For the implementation agent: execute the ordered tasks below using the user's chosen building agent. Read the requirements and technical design first. This document authorizes planning only; implementation and external release actions require their own applicable authorization. No additional agent framework or plugin is required by this plan.

**Goal:** Deliver a small, correct EventBook application with working live links, tested backend rules, and an honest submission.

**Architecture:** Browser-rendered Next.js calls a separate FastAPI REST backend directly. Only FastAPI accesses PostgreSQL. Local development uses Docker Compose; deployed data lives in Supabase PostgreSQL.

**Tech Stack:** Next.js, TypeScript, FastAPI, Pydantic, synchronous SQLAlchemy and psycopg, Alembic, Argon2id, pytest, Docker Compose v2.

**Spec:** [Requirements](REQUIREMENTS.md), [technical design](TECHNICAL_DESIGN.md), and [original brief](Intern_Project_Brief.pdf). File paths and commands below are proposed implementation contracts, not files or commands claimed to exist today.

## Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

The root filename is intentional for the requested Markdown handoff, overriding the planning skills' default output directories. Preserve one authoritative plan. The human owns review and submission; the team lead reviews Markdown evidence; the building agent implements tasks and reports verified results here.

Budget roughly **10–14 hours** as an effort target, not a guaranteed schedule. Suggested allocations total 10–14 hours: foundation 1.5–2, auth 1–1.5, public events 0.5–0.75, bookings 1.5–2, admin 0.75–1, early release 0.5–0.75, remaining frontend 2–2.5, and final checks/docs/release 2.25–3.5. These include each task's tests and fixes; selected Compose tooling and hosting friction can exceed the target. Review remaining time after each gate and report scope pressure immediately. Cut decorative polish and deferred bonuses first; do not silently omit mandatory rules or selected Compose scope.

## 1. Requirements & Constraints

- **REQ-001**: Visitors browse upcoming events with seats left, title search, server pagination, and full detail. Users register/login/logout, book one seat, view their own bookings, and cancel eligible bookings.
- **REQ-002**: Enforce `REQUIREMENTS.md` B1–B6 through direct API calls: no duplicate active booking, no overbooking, no past booking/cancellation, owner-only cancellation freeing a seat, no capacity below active bookings, and admin-only event management/attendees.
- **REQ-003**: Seed admin/user accounts and enough events for pagination, including past and nearly full events. Provide at least three meaningful automated backend tests with one command.
- **REQ-004**: Docker Compose local development is **required by the user**, though it is a PDF bonus. Production remains Supabase PostgreSQL. Preserve the technical design's opaque sessions, active-booking count, event-row locking, and deletion policy.
- **REQ-005**: Deploy working frontend/API links, seed live accounts, maintain availability for at least two weeks after submission, and provide the complete README and accessible GitHub repository.
- **SEC-001**: Hash passwords, enforce backend permissions, validate inputs, hide stack traces, keep secrets in env, ignore actual `.env`, commit examples, and prevent public admin assignment. Keep privileged DB credentials out of runtime/browser where specified.
- **CON-001**: Next.js is frontend only: no Supabase queries, backend API routes, or backend server actions. Custom backend auth replaces Supabase Auth. Do not add payments, notifications, force deletion, or unrelated features.
- **CON-002**: Confirmation deadline: **Friday, 16 October 2026, 6:00 PM NPT (UTC+05:45)**. Submission deadline: **Sunday, 18 October 2026, 6:00 PM NPT**. Human replies to the original email; this plan does not send messages.
- **GUD-001**: Prioritize login → booking rules → admin event management → frontend polish. Evaluation ranks live correctness first, then model/API/code quality, security/validation, frontend UX, and README/Git/tests.
- **GUD-002**: Commit meaningful increments as work progresses when authorized; otherwise present commit-ready checkpoints for the human. Do not wait for a final 1–3 giant commits. Update actual README decisions continuously and disclose AI tools and their uses honestly.
- **PAT-001**: For each behavior task, write a focused failing test, run and confirm the intended failure, implement the smallest behavior, rerun to green, and inspect affected regressions. A missing dependency is not evidence of a meaningful red test. Configuration-only steps use health/config checks rather than artificial unit tests.

### Review Focus

Each condition has an owning verification step below; retain the test when implementation changes:

1. A lock wait crosses an event's start time: check fresh database time after obtaining the event lock (TASK-005).
2. A response is lost after a booking commits: refetch own bookings rather than blindly retrying POST (TASK-008).
3. Search contains literal `%`, `_`, or backslashes: escape LIKE metacharacters and keep totals/filter consistent (TASK-004).
4. A browser runs outside Nepal: admin input/display still use the labeled Nepal timezone (TASK-008).
5. A test command receives a development/production URL: reject before migrations or cleanup (TASK-002).

## 2. Implementation Steps

Tasks are sequential unless a dependency explicitly allows overlap. Read the task's named technical-design sections before writing code. Check a step only after its verification succeeds; preserve incomplete status when blocked.

### Implementation Phase 1: Local foundation and database

- **GOAL-001**: Establish reproducible development and isolated PostgreSQL verification without implementing product features prematurely.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | Compose and minimal app readiness; no dependencies. | Yes | 2026-10-15 |
| TASK-002 | Schema, privileges, fixtures, repeatable seed; depends on TASK-001. | Yes | 2026-10-15 |

#### TASK-001 execution

**Files:** root `compose.yaml`, `.env.example`, `.gitignore`, `README.md`; `backend/Dockerfile`, `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/main.py`, `backend/app/config.py`, `backend/app/db.py`; `frontend/Dockerfile`, `frontend/package.json`, lockfile, TypeScript/Next configuration, `frontend/src/app/layout.tsx`, `frontend/src/app/page.tsx`. Keep generated configuration needed to build; remove sample assets and unused boilerplate.

**Interface:** backend exports `create_app() -> FastAPI`; settings provide the design's runtime/migration/test URLs only to the appropriate process; `get_db()` yields a request-scoped SQLAlchemy Session. Startup does not mutate the schema. Implement `/health` readiness against expected schema/revision, including sanitized 503 before migration. Task 2 supplies that schema.

- [x] Pin compatible frontend/backend dependencies and the PostgreSQL image, matching the target Supabase major version when available. Record versions; if project access is unavailable, label the local version provisional and reconcile at TASK-007.
- [x] Define `db`, `backend`, `frontend`, and profile `tools` exactly as the design specifies: localhost-only HTTP ports, internal `db:5432`, health ordering, persistent DB volume, source hot reload, separate frontend dependency/cache volumes, explicit per-service env mappings.
- [x] Add configuration validation, exact local CORS origin, parameterized DB access, bounded connection pool, shared sanitized error envelope, and 503 readiness before migrations. Add no automatic migrations or seeds.
- [x] Run future `docker compose config --quiet` after local env setup and build images. Start only DB/tools while schema is absent; verify DB health and that the API reports 503 without leaking credentials when started independently. Do not wait for frontend's healthy-backend dependency before TASK-002.
- [x] Record deliverables and actual setup commands in README and progress evidence. **Done:** images build, Compose validates, env files are ignored, no secret enters frontend, and missing-schema readiness behaves intentionally.

#### TASK-002 execution

**Files:** `backend/app/models.py`, `backend/app/bootstrap_local.py`, `backend/app/seed.py`, `backend/app/passwords.py`, `backend/alembic.ini`, `backend/migrations/env.py`, `backend/migrations/versions/0001_initial.py`, `backend/tests/conftest.py`, `backend/tests/test_database.py`; update `backend/app/db.py`, config and README.

**Interface:** Alembic uses `MIGRATION_DATABASE_URL`; `python -m app.bootstrap_local` provisions local roles/databases explicitly; `python -m app.seed` uses privileged seed credentials. `pytest` test setup guards the exact isolated target before schema work and uses `TEST_MIGRATION_DATABASE_URL` for migrations, `TEST_DATABASE_URL` for API execution. Create `hash_password(password: str) -> str` and `verify_password(password: str, password_hash: str) -> bool` in `app/passwords.py` in this task; both seed and TASK-003 auth import them. Seed credentials are hashed from the first runnable seed, never temporarily stored plaintext.

- [x] Write tests for duplicate active-booking uniqueness, rebooking after cancellation, FK/check constraints, runtime role restrictions, and refusing a wrong test target before destructive operations. Run the meaningful red cases against the isolated PostgreSQL database after bootstrap is available.
- [x] Bootstrap `eventbook_dev` and `eventbook_test` with separate migration/runtime roles. Restrict database CONNECT and private-schema grants; test roles cannot access dev, dev runtime cannot access test, public roles cannot access app tables. Handle hosted-only roles conditionally rather than requiring them on local PostgreSQL.
- [x] Implement the four design tables, checks, FKs, indexes and column grants through a migration. Runtime cannot grant itself admin. Make the migration and runtime connection roles distinct; Alembic version-table access must support readiness without granting runtime schema ownership.
- [x] Implement the shared Argon2id password helper and seed's stable IDs, 12 upcoming/one past event, two demo accounts, and capacity-2 event with one seeded booking (admin-held at the time; moved to the normal user under the later management-only scope, see PROGRESS). Reuse the helper in TASK-003. Run seed twice; prove no duplicate records, silent credential resets, or unrelated data deletion.
- [x] Run bootstrap → migration → seed explicitly using the technical-design commands. Start frontend/backend; confirm healthy readiness and that editing source reloads each app. Stop/restart without deleting volumes and prove records persist.
- [x] Run future `docker compose --profile tools run --rm tools pytest` and prove its configuration refuses dev/production-like targets before migrations/cleanup. **Done:** schema/seed/grant tests pass against real PostgreSQL, both environments are isolated, and startup works from documented setup.

### Implementation Phase 2: Authentication and core backend

- **GOAL-002**: Complete custom auth and mandatory transactional rules before investing in visual polish.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-003 | Auth and permission helpers; depends on TASK-002. | Yes | 2026-10-15 |
| TASK-004 | Public events/search/pagination; depends on TASK-002. Execute after TASK-003 for the default priority order. | Yes | 2026-10-15 |
| TASK-005 | Booking/history/cancellation and transaction protocol; depends on TASK-003 and TASK-004. | Yes | 2026-10-15 |
| TASK-006 | Admin event management/attendees; depends on TASK-005. | Yes | 2026-10-15 |

#### TASK-003 execution

**Files:** `backend/app/auth.py`, `backend/app/errors.py`, `backend/tests/test_auth.py`; update main, config, models and seed only as needed.

**Interface:** `get_current_user()` resolves bearer session to public actor; `require_admin()` rejects non-admins. Implement the exact `/api/auth/register`, `/login`, `/me`, `/logout` contracts under `/api/auth`. Export public User shape only; hashed fields remain internal.

- [x] Add failing HTTP tests: normalized duplicate email; rejection of `role`/unknown fields; Argon2id storage; generic invalid login; valid login/me; expired/revoked session; logout invalidates that token; normal user rejected by admin dependency. Test session expiry by database fixture updates, not production clock overrides.
- [x] Implement strict validation and Argon2id hashing/dummy verification using TASK-002's password helper; registration omits the INSERT `role` column and uses its database server default. Generate a random 32-byte opaque token, persist only SHA-256 hash, return raw token once with 24-hour expiry; read current role from DB each request.
- [x] Implement consistent JSON errors/statuses and bearer challenge, sanitizing FastAPI validation details so password/token input never appears in errors/logs. End authentication read transactions before module-owned write/read-isolation transactions begin; avoid SQLAlchemy autobegin conflicts or changing isolation after queries.
- [x] Run auth tests and relevant schema tests; inspect responses/logs for hashes or raw credentials. **Done:** direct HTTP auth lifecycle passes and the same helper hashes seed passwords; no Supabase Auth dependency exists.

#### TASK-004 execution

**Files:** `backend/app/events.py`, `backend/tests/test_events.py`; update route registration.

**Interface:** `GET /api/events` and `GET /api/events/{event_id}` return the design's EventSummary/EventDetail and collection envelope. Reuse a page validation helper within this module or `backend/app/pagination.py` for later collections.

- [x] Add failing HTTP tests for upcoming-only listing, past detail availability, seats left from active rows, case-insensitive search, literal `%`/`_`/backslash input, page boundaries, empty/out-of-range pages, stable ordering/totals, and query bounds.
- [x] Implement SQL filtering and LIMIT/OFFSET with design defaults/bounds; count and items share a short read-only REPEATABLE READ transaction and the same filters. Count active seats in a bounded aggregate query, avoiding per-event queries or frontend slicing.
- [x] Run focused tests and inspect generated SQL/query count for one listing. **Done:** public contracts and error cases pass without authentication, and returned lists are database-paginated.

#### TASK-005 execution

**Files:** `backend/app/bookings.py`, `backend/tests/test_bookings.py`, `backend/tests/test_concurrency.py`; update routes and common error mappings.

**Interface:** `POST /api/events/{event_id}/bookings`, `GET /api/bookings/me`, `DELETE /api/bookings/{booking_id}` match the design. The booking module receives actor and IDs, owns transaction completion, and returns only committed results. Cancellation hard-deletes an owned future booking; current history excludes legacy soft-cancelled rows.

- [x] Add failing integration cases for duplicate rejection, cancellation freeing capacity, rebooking, full/past booking, past cancellation, owner-only access, repeated-cancellation 404, and own-history pagination. Use at least two users and query final database state after errors.
- [x] Implement READ COMMITTED event-row `FOR UPDATE` first; then fresh wall-clock eligibility, active duplicate/capacity queries in subsequent statements, mutation and commit. Cancellation may read an actor-scoped booking to find event ID before locking, but locks event before rereading/changing booking. Map known conflicts after rollback; set 5-second lock and 10-second statement timeouts.
- [x] Verify eligibility after a lock wait crossing start time. Use a short controlled PostgreSQL fixture and two connections with synchronization, bounded waits, and generous test timeouts; do not rely on request-arrival time or transaction-start `now()`.
- [x] Run core rule tests and inspect the locked capacity protocol. **Done:** mandatory rules B1–B4 are green with no mutation on rejection. Reserve the dedicated simultaneous-last-seat bonus demonstration/test for TASK-009 after required functionality works; the mandatory lock protocol and never-overbook invariant apply immediately.

#### TASK-006 execution

**Files:** `backend/app/admin.py`, `backend/tests/test_admin.py`; share event mutation helpers with `events.py`/`bookings.py` where they remove repeated locking logic.

**Interface:** all `/api/admin/events` CRUD/list routes and the attendee collection match the design; current user must pass `require_admin()` before any data disclosure. Reuse pagination and EventDetail shapes.

- [x] Add failing direct-API tests for unauthenticated/normal-user rejection on every admin route, input bounds/naive dates, capacity below/equal active count, active attendee privacy, past events, and deletion policy.
- [x] Implement admin list including past events, validated CRUD with all required event fields, and active-only attendee pagination. Created events are immediately public; public inputs cannot assign an owner/role.
- [x] For editing/deletion use the same event-first lock protocol. Reject capacity below active bookings and deletion with any current booking, including past events. Permit deletion otherwise and cascade only any legacy soft-cancelled rows. Verify persisted state after failed edits/deletes.
- [x] Run all backend rule tests and inspect edit/book serialization. Reserve the optional edit-versus-book concurrency demonstration for TASK-009. **Done:** B5–B6 and chosen deletion policy pass via direct API; README explains capacity/deletion/time trade-offs.

### Implementation Phase 3: Early release and complete user interface

- **GOAL-003**: Expose a working initial slice early, then complete every role flow with clear feedback.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-007 | Early deployment checkpoint with public browsing/auth slice; depends on TASK-006. | In progress | 2026-10-17 |
| TASK-008 | Complete user/admin frontend and UX checks; depends on TASK-007. Local work can continue if hosting access is blocked. | Yes | 2026-10-16 |

#### TASK-007 execution

**Files:** `frontend/src/lib/api.ts`, `frontend/src/lib/auth.tsx`, `frontend/src/app/login/page.tsx`, `frontend/src/app/register/page.tsx`, root listing page; `backend/Dockerfile` production target/config as needed; README deployment instructions. Do not introduce unused provider configuration files.

**Interface:** typed client uses browser-reachable `NEXT_PUBLIC_API_BASE_URL`; auth provider restores sessionStorage on hydration then validates `/auth/me`. Return shared error codes to forms. No backend proxy, Next API routes, or Supabase access.

- [x] Build login/register/logout and a minimal browsable event list against real FastAPI; show pending, empty, failure, and expired-session states. Never place bearer tokens in URLs/HTML/logs. Add a focused client test if a test harness is introduced; otherwise record browser checks for reload restoration and token clearing.
- [x] Prepare production build/start configuration without development reload, separate runtime/migration credentials, exact CORS, and HTTPS API URL. Check frontend production build/typecheck and backend tests locally before external release.
- [x] With deployment authorization and accounts, deploy the scoped release to the recorded hosts; provision Supabase roles/private schema, explicitly apply migrations, and confirm PostgreSQL version, runtime grants, and readiness. Hosted provisioning remains manual; the scripted equivalent, seed verification, TLS/pool-limit and exposed-schema isolation rechecks remain open.
- [ ] Verify live listing and login with both accounts; record app/API URLs, deployed revision, seed verification, cold-start behavior, and missing flows in README/evidence. Live listing/detail and readiness are verified at `event-booking-chi-seven.vercel.app` on `0002_booking_hard_delete`; login with both accounts and remaining acceptance checks are still open. **Done:** working deployed initial slice is accessible; it is not yet final acceptance. If external access is unavailable, record the exact block, keep this task incomplete, and continue TASK-008 locally. A local build never satisfies compulsory deployment.

**Repo-side preparation (2026-10-17, not deployment):** `vercel.json` declares both Vercel Services in one project (nextjs `frontend/`, fastapi `backend/`); `/api/*` and `/health` route to the backend and everything else to the frontend, preserving the direct same-origin browser-to-API path. README records project setup, environment values, pre-deploy migration/seed commands and verification steps.

**Hosted release (2026-10-18, partial):** Supabase is at `0002_booking_hard_delete`; read-only checks confirmed runtime DELETE granted and UPDATE(`cancelled_at`) revoked. Vercel deployment from `5d5ae31` is Ready; live health, listing, detail, and homepage return HTTP 200. Login with both accounts, the scripted provisioning path, remaining infrastructure checks, and milestone review remain open; TASK-007 is not complete.

#### TASK-008 execution

**Files:** `frontend/src/app/events/[id]/page.tsx`, `frontend/src/app/bookings/page.tsx`, `frontend/src/app/admin/page.tsx`, `frontend/src/components/event-form.tsx`, `frontend/src/lib/datetime.ts`; update listing/layout/auth/client files and shared styles. Split further only if needed for clear responsibility.

**Interface:** use the design's REST shapes; search/page live in URL params. Nepal timezone formatting/conversion is explicit. Authenticated HTTP responses/private client data are not cached across users.

- [x] Complete listing search and server page navigation, detail, booking, own bookings/history/cancellation, admin event list/create/edit/delete, and attendee display. Enforce backend outcomes rather than assuming visible buttons guarantee permission.
- [x] Add mobile layout plus loading/error/empty states for each collection/form/action. Disable duplicate submissions while pending; explain full/past/conflicting capacity/deletion errors. Refetch seats/history after success or conflict; never optimistically claim an uncommitted seat.
- [x] Restore/check session on reload, clear on 401, clear all private state when user changes. Logout clears local token even on network failure and explains if server revocation did not complete. Admin navigation is role-aware while direct API protections remain authoritative.
- [x] Test a lost booking response: arrange a committed booking with response delivery failure, then verify UI refetches own bookings before offering another action rather than automatic POST retry. Test stale search results cannot overwrite the latest query.
- [x] Test with browser timezone outside Nepal: detail and admin form remain labeled Nepal time and submit explicit-offset timestamps. Verify naive API times fail and started-event buttons/errors match backend rules.
- [x] Run frontend build/typecheck and manually exercise visitor → user → admin flows at phone width, including empty dataset, unavailable API, expiry, and normal-user access to admin URLs. **Done:** all required role flows work with actual backend data, responsive feedback, and no cosmetic-only features.

### Implementation Phase 4: Acceptance and submission readiness

- **GOAL-004**: Produce verified live software and complete, accurate handoff/submission evidence.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-009 | Final regression, release, README, and human submission handoff; depends on all prior required deliverables. | No | — |

#### TASK-009 execution

**Files:** README, this plan's progress/evidence, fixes to task-owned files only. Update technical design for justified actual deviations; preserve requirement/source distinctions.

- [ ] Follow README from a clean disposable local Compose project: explicit bootstrap/migration/seed, startup, hot reload, persistence across `down`/up, and isolated test command. Never reset the developer's data to simulate a clean start. Explain destructive volume reset separately.
- [ ] Run the full backend suite with one command, frontend build/typecheck, and the direct-API acceptance checks. Count at least three meaningful backend tests; report exact command, result, covered rules, and any skipped bonus evidence. Recheck secret hygiene, runtime grants, error sanitization, and absence of frontend Supabase/backend code.
- [ ] Remove unused files, dead/commented code, leftover scaffold assets, inconsistent patterns, and misleading UI. Inspect Git history for meaningful increments and ensure the human can explain every file. Record AI tools and use honestly.
- [ ] Release final changes with authorization, migrate once if needed, seed live demo data explicitly, and repeat all `REQUIREMENTS.md` section 14 live checks: auth, booking/cancel, duplicate/full/past rejection, ownership/admin direct API denial, search/pagination, capacity/deletion, and both test accounts. Record actual live revision and failures; no local-only claim substitutes for live evidence.
- [ ] Only after required functionality works, if time remains, implement/run bonus `backend/tests/test_concurrency.py`: two independent connections/HTTP requests contend for one remaining seat; exactly one succeeds, the other gets `EVENT_FULL`, final active count equals capacity. Synchronize with a barrier/event, use real committed PostgreSQL fixtures, and clean them afterwards. Explain the lock mechanism in README; optionally add edit-versus-book proof. A skipped bonus is reported separately and never relaxes mandatory overbooking prevention.
- [ ] Complete README in the developer's own words: live app/API and admin/user logins; stack and why; local/Compose/migration/seed/test commands; actual tables and endpoints; seat-count/locking/deletion/time/auth-storage trade-offs; AI use; known issues/next steps; backend sleep note if applicable.
- [ ] Prepare human submission packet with app URL, API URL, GitHub link (public or evaluator access), and README. Human confirms participation by **Friday, 16 October 2026, 6:00 PM NPT** and replies to the original email with submission before **Sunday, 18 October 2026, 6:00 PM NPT**. Do not defer confirmation until this final task; track it independently from day one.
- [ ] Arrange availability at least two weeks after actual submission (through at least **1 November 2026, 6:00 PM NPT** if submitted at deadline). Explain cold starts in README. **Done:** all required acceptance items have evidence and final live links work; otherwise label submission incomplete, deploy working parts, and describe missing work/how to build it without missing the deadline.

### Progress and review protocol

After each task, update its table state/date and append a short evidence entry below using this format. Use `In progress`, `Blocked`, or `Yes` in Completed; leave untouched tasks `No`. Only mark `Yes` after its done gate. Task numbers reference the unique declarations above.

```text
Task: TASK-005
Status: In progress
Changed: backend/app/bookings.py; backend/tests/test_bookings.py
Evidence: exact command/check, timestamp in NPT, actual result, and rule proved
Decisions: accepted design change with reason, or none
Remaining: concrete unmet gate, dependency, or none
Next: next task/check and any user action genuinely needed
```

The example is a reporting format, not a claim of implementation. Keep credentials/tokens out of evidence. If a verification fails, record the failure and resolve it before dependent completion. Send questions or review requests through Markdown for the human/team lead; this plan does not authorize messaging other chats or external parties. Record actual commands once created rather than pasting proposed commands as successful runs.

## 3. Alternatives

- **ALT-001**: Express/Django REST are allowed by the PDF but FastAPI is the confirmed choice.
- **ALT-002**: Full local Supabase and Docker-hosted production are unnecessary; local plain PostgreSQL preserves required semantics, production stays hosted Supabase.
- **ALT-003**: JWT refresh machinery, cookie cross-site configuration, stored seat counters, generic repository layers, and broad frontend test tooling are unnecessary for this chosen small design. Preserve the documented opaque-session and count/lock trade-offs.
- **ALT-004**: Login rate limiting remains deferred optional work. Compose is selected required scope. Explicit concurrent last-seat proof is selected bonus evidence and never excuses an unsafe mandatory booking implementation.

## 4. Dependencies

- **DEP-001**: Docker Engine/Compose v2 and local resources for PostgreSQL, Node frontend, Python backend/tools. Dependency installation/build is future implementation work.
- **DEP-002**: An isolated real PostgreSQL test database with distinct migration/runtime credentials; shared production credentials are unacceptable.
- **DEP-003**: Hosting/Supabase/GitHub access and authorization for external deployment/invitations/submission. Missing access blocks live completion, not local tasks. No new account, deployment, email, or invitation is performed by writing this plan.
- **DEP-004**: Check applicable AGENTS.md and relevant implementation skills before touching code, especially PostgreSQL guidance before migrations/grants, and React/FastAPI/testing guidance when applicable. This plan is not a replacement for workspace instructions.

## 5. Files

- **FILE-001**: Root `compose.yaml`, `.env.example`, `.gitignore`, README and this progress record: local orchestration, safe configuration and review evidence.
- **FILE-002**: `backend/app/{main,config,db,models,errors}.py`, `backend/pyproject.toml`, Dockerfile: backend entry/configuration, DB sessions, shared shapes/errors and packaging.
- **FILE-003**: `backend/app/{bootstrap_local,seed,passwords,auth,events,bookings,admin}.py`, migration files listed in TASK-002: explicit setup, shared credential hashing and behavior-owning modules.
- **FILE-004**: `backend/tests/{conftest,test_database,test_auth,test_events,test_bookings,test_concurrency,test_admin}.py`: isolated HTTP/PostgreSQL rule verification.
- **FILE-005**: Frontend paths listed in TASK-001/007/008, lockfile and styling: typed REST client, auth state, responsive role flows. Brace notation here denotes the explicitly named files, not a required shell command.

## 6. Testing

- **TEST-001**: TASK-001/002 verify Compose configuration/build, missing-schema readiness, explicit setup, hot reload, persistence, grant isolation, and refusal of wrong test targets.
- **TEST-002**: TASK-003 verifies role-safe auth, hashed credentials, expiry/logout revocation, sanitized errors and public-only responses.
- **TEST-003**: TASK-004 verifies SQL search/pagination, literal wildcards, counts, ordering and seat calculations.
- **TEST-004**: TASK-005 verifies B1–B4 and time-after-lock semantics with real PostgreSQL; TASK-009 owns separately recorded last-seat bonus proof after mandatory functionality works.
- **TEST-005**: TASK-006 verifies B5–B6, exact admin field validation, deletion policy and attendee privacy.
- **TEST-006**: TASK-007/008 verify actual browser/API integration, session handling, mobile/error/empty/loading states, lost-response recovery, Nepal-time behavior, and production frontend build.
- **TEST-007**: TASK-009 repeats the complete requirements acceptance checklist live and from documented local setup, linking actual results rather than assumed completion.

## 7. Risks & Assumptions

- **RISK-001**: Pooler/TLS/major-version differences and platform grants can break release despite local tests; deploy the initial slice at TASK-007 and reserve final buffer.
- **RISK-002**: Capacity safety depends on every writer locking event first and counting afterwards at READ COMMITTED; admin/seed maintenance must preserve that protocol. Audit all writes, not only booking POST.
- **RISK-003**: SessionStorage tokens are JavaScript-readable; plain-text rendering and absence of unsafe HTML reduce XSS exposure. Retain this documented trade-off without silently changing auth halfway through implementation.
- **RISK-004**: Time pressure and selected Compose scope may exceed 10–14 hours. Preserve live correctness, report gaps, and submit honestly on time; do not claim unfinished gates pass.
- **ASSUMPTION-001**: Proposed internal files/module names may be refined for clarity with a recorded reason, while REST contracts, user selections and acceptance behavior remain aligned with the source documents.
- **ASSUMPTION-002**: The human handles participation confirmation, repository access, final email, and deployment authorization. No framework/product choice is currently awaiting clarification.

## 8. Related Specifications / Further Reading

- `REQUIREMENTS.md`: authoritative translated acceptance scope and submission obligations; B1–B6 map to TASK-005/006.
- `TECHNICAL_DESIGN.md`: database/access/auth/REST/transaction/time/Compose contracts; tasks reference named sections instead of duplicating schema or API definitions.
- `Intern_Project_Brief.pdf`: all four pages checked for scope, quality, submission, priorities and bonus distinctions. Page 4 adds motivation, no further implementation requirement.

Traceability review: visitor capabilities → TASK-004/008; auth/user capabilities → TASK-003/005/008; admin capabilities → TASK-006/008; security → TASK-001/002/003/006/009; seeds/tests → TASK-002–006/009; selected Compose → TASK-001/002/009; deployment → TASK-007/009; documentation, AI disclosure, Git history and submission → continuous task evidence plus TASK-009. Required items and selected scope have owners; deferred bonuses do not block mandatory acceptance.
