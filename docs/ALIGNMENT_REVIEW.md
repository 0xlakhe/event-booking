# PDF alignment review

Audit date: 15 October 2026, Nepal Time. Status: documentation review only.

## Assessment and reviewed scope

**The documents are close to the PDF in required scope, but the proposed implementation process is more elaborate than the brief's minimal 10–14 hour target.** No missing mandatory PDF requirement was identified in this review. That is a documentation finding, not a claim that the app meets any acceptance test.

Reviewed every project Markdown file present at audit start: `REQUIREMENTS.md`, `TECHNICAL_DESIGN.md`, and `IMPLEMENTATION_PLAN.md`. Read all four pages of `Intern_Project_Brief.pdf` and checked the requirement-to-design-to-task chain. Inventory used `rg --files --hidden` with `.git`, `.agents`, `.codex`, and `node_modules` excluded as internal/dependency material; no additional project Markdown files were found. This report is the new fourth project Markdown file and has been checked for consistency with those sources.

The workspace contains the PDF and Markdown handoff documents; no application source, Compose file, migrations, runnable tests, final README, or deployment evidence is present. Plan status is Planned, task tables remain No, and acceptance boxes remain unchecked. Proposed commands and progress examples are not successful-run claims.

## Requirement traceability

“Covered” below means specified with an implementation owner, not implemented or tested.

| PDF requirement / source | Requirements reference | Design reference | Plan owner | Audit result |
| --- | --- | --- | --- | --- |
| Next.js + TypeScript; allowed separate backend; Supabase PostgreSQL (p1 §2) | §3 | Architecture, deployment | TASK-001/007/009 | Covered; FastAPI selected within allowed options. |
| REST separation; no Next backend routes/actions or Supabase queries; backend custom auth; no frontend service-role key (p1 §2) | §3/6/14 | Architecture, auth, private schema/config | TASK-001/003/007/009 | Covered. |
| Public upcoming list, remaining seats, title search, server pagination, detail (p1 §3) | §4/14 | Public REST routes and SQL pagination | TASK-004/008/009 | Covered; no frontend slicing substitute. |
| Register/login/logout, one-seat booking, own bookings/cancel (p1 §3) | §4/14 | Auth and booking contracts | TASK-003/005/008/009 | Covered. |
| Admin event CRUD and required fields, attendee list, seeded admin/no self-promotion (p1 §3) | §4/6/8/14 | Admin routes, users grants, seed | TASK-002/003/006/008 | Covered. |
| B1: duplicate booking forbidden until cancellation (p1 §4) | B1 | Partial unique index and booking protocol | TASK-002/005 | Covered. |
| B2: no overbooking (p1 §4) | B2 | Active counts and shared event-row lock | TASK-005/006/009 | Covered in design; needs actual DB evidence. |
| B3: past booking and cancellation forbidden (p1 §4) | B3 | Fresh clock after lock, explicit time boundary | TASK-005/008 | Covered. |
| B4: owner-only cancellation frees seat (p1 §4) | B4 | Actor-scoped cancellation and active counts | TASK-005 | Covered. |
| B5: capacity cannot fall below booked count (p1 §4) | B5 | Locked admin edits | TASK-006 | Covered. |
| B6: only admins manage events/attendees (p1 §4) | B6 | Backend role checks | TASK-003/006/009 | Covered, including direct API checks. |
| Decide uncovered edge cases; explain deletion behavior (p2 §4–5) | §5/12 | Reject deletion with active bookings; otherwise cascade cancelled history | TASK-006/009 | Covered; policy is a design choice. |
| Developer chooses model, routes/payloads/errors, UI, folders/libraries; explain reasoning (p2 §5) | §12 | Proposed choices explicitly labeled | All tasks; README TASK-009 | Covered; no schema falsely attributed to PDF. |
| Hash passwords, protected routes, env-only secrets, ignore env/commit example (p2 §6) | §6/14 | Argon2id, sessions, grants/config | TASK-001/002/003/009 | Covered. |
| Server validation, HTTP statuses, clear errors/no stack traces (p2 §6) | §6 | Input/error contract | TASK-001/003–006/009 | Covered. |
| Mobile UX, loading/error/empty states and failed-action feedback (p2 §6) | §7/14 | Frontend behavior | TASK-007/008/009 | Covered. |
| Admin + user, enough events for pagination/rules, past + nearly full event (p2 §6) | §8 | Seed dataset | TASK-002/007/009 | Covered; seed count/content are proposals. |
| At least three automated backend tests, one test command (p2 §6, p3 §12) | §9/14 | PostgreSQL pytest suite | TASK-002–006/009 | Covered; planned suite exceeds minimum. |
| Incremental meaningful Git history; explainable/clean code/no fake features (p2 §6/8, p3 §12) | §7/11/14 | Small modules, actual docs | Continuous checkpoints, TASK-009 | Covered; no commit history claimed. |
| Compulsory working live app/API, seeded test accounts, any suitable hosts, 2-week retention, sleep note (p2 §7) | §2/10/11/14 | Deployment/config | TASK-007/009 | Covered; operationally unfulfilled. |
| AI allowed; honest tool/use disclosure; own understanding and walkthrough (p2 §8) | §1/7/11/14 | README guidance | TASK-009, human walkthrough | Covered. |
| App/API URLs, GitHub public or invited, README all eight topics, reply to original email (p3 §9) | §11 | README guidance | TASK-009 | Covered; no email sent. |
| Confirmation 16 Oct 2026 6 PM NPT; submission 18 Oct 2026 6 PM NPT (p1, p3 §9) | §2 | Defers to requirements | CON-002, TASK-009 | Exact dates/times preserved; weekdays verified. |
| Incomplete submission allowed honestly; login → booking → admin → polish; evaluation order (p3 §9/12) | §2/15 | Small-scope guidance | Intro, GUD-001, TASK-009 | Covered; incomplete is not complete. |
| Suggested three-day sequence/early deployment/buffer (p3 §10) | §15 | Deployment guidance | TASK-007/009 | Represented; early checkpoint timing remains a risk below. |
| Concurrency explanation, Compose, login rate limit are bonuses after required work (p3 §11) | §13 | Bonus distinction; Compose selection | TASK-001/002/009, ALT-004 | Preserved except explicit user elevation of Compose. Bonus proof now scheduled after mandatory functionality. |
| Final live self-check (p3 §12); motivational note (p4) | §14 | Verification references | TASK-009 | Self-check covered; p4 adds no extra functional mandate. |

## Findings and corrections made

1. **Stale decision state:** requirements still called already-proposed choices “open,” and design still referred to a future plan. Updated both to point at the existing design/plan without claiming proposals were PDF mandates.
2. **Seed/auth dependency ambiguity:** TASK-002 referred to a helper created in later TASK-003 while needing hashes immediately. Assigned shared `app/passwords.py` helpers to TASK-002 and made auth reuse them. No plaintext interim seed is permitted.
3. **Bonus ordering drift:** dedicated last-seat bonus proof appeared inside the mandatory backend phase before the rest of the app worked. Moved that demonstration to TASK-009 after required functionality works. Mandatory capacity locking and rule tests remain earlier; no weakening of B2.
4. **ORM/grant mismatch risk:** column-level role restrictions could conflict with an ORM INSERT explicitly supplying the role. Clarified the server default and omission of the role column in normal registration; role remains seed-only.
5. **Transaction contract gap:** the plan warned about authentication opening a transaction, while the design did not spell out the same lifecycle. Added explicit auth-read completion/plain actor values and isolation selection before module queries. This preserves the chosen locking strategy rather than changing it.

## User choices, design additions, and scope pressure

| Category | Items | Relationship to PDF |
| --- | --- | --- |
| Explicit user selections | FastAPI; Compose locally with plain PostgreSQL; Supabase in production | FastAPI is allowed; Compose elevates a PDF bonus; local plain PostgreSQL is the agreed development workflow, not a replacement for production Supabase. |
| Reasonable implementation choices | Four tables, UUIDs, Argon2id, hashed opaque sessions, 24-hour expiry, sessionStorage, API shapes/error codes, private schema, non-owner runtime, lock/count strategy, Nepal-only presentation, deletion policy | Brief delegates these choices; they must be explained, not presented as source mandates. |
| Added implementation work | Separate migration/runtime/test roles, bootstrap tooling, four Compose services including one-off tools, repeatable 13-event seed, broad negative-case tests, snapshot-consistent pagination | Supports quality but exceeds minimum specificity; main risk is time, not missing product scope. |
| Still optional | Dedicated simultaneous-last-seat proof/explanation, login rate limiting | Only after required work; unsafe overbooking is never allowed. No extra feature has been silently selected. |

The proposed app features remain small. Its operational setup and verification are comparatively ambitious. The 10–14 hour allocation is an estimate; there is no evidence yet that this exact design can be built and deployed within it. Do not add a generalized architecture or more tooling. Simplifying agreed mechanics materially would require an explicit documented design revision, not quietly skipping them.

## Remaining risks and decisions

- **Deployment timing:** TASK-007 follows all backend tasks, so “early” means before frontend completion, not early in backend work. A bootstrap/roles problem could consume the budget first. Recommended planning revision: prepare host connectivity/config while TASK-003/004 finish and consider releasing that auth/list slice earlier. This review leaves the agreed task dependencies unchanged; it is an open scheduling improvement, not a PDF functional gap.
- **Security trade-off:** sessionStorage is exposed to JavaScript/XSS. Documented plain-text rendering and token hygiene do not make it immune. The chosen approach is unchanged; test logout/expiry/clearing and avoid unsafe HTML.
- **Capacity safety:** safe only if every runtime and maintenance writer follows event-first locks and counts after acquiring the lock. No cross-table CHECK or arbitrary privileged-SQL protection is claimed. Real integration/concurrency evidence is still absent.
- **Hosting feasibility:** Supabase grants/schema exposure, pool connectivity/TLS, actual PostgreSQL major version, live seed freshness, and free-host sleep/retention need verification on the actual project. No credentials, URLs, or hosting access have been verified.
- **Time-sensitive demo data:** relative dates become stale and the nearly-full event can fill during review. Repeatable seeds intentionally do not silently reset records. Confirm useful live samples before submission and document any deliberate demo refresh.
- **Delivery ownership:** human must confirm participation and submit; GitHub access and 2-week availability still need arrangements. If submitted at the deadline, retention ends no earlier than 1 November 2026, 6:00 PM NPT.

No new product choice is required to understand the existing design. The scheduling recommendation is unresolved; deployment inputs remain operationally pending. These documents are aligned enough for an implementation agent to proceed with the agreed scope, but **documents aligned does not mean implementation complete: the app has not been built, tested, or deployed**.

## Audit evidence

Terminal checks: inventory of all project Markdown; full PDF text extraction page by page with pypdf; full-document reads plus targeted rereads; cross-document traceability; task identifier/reference validation; date/weekday/retention arithmetic; no checked acceptance/task completion markers; workspace inventory showing only PDF/Markdown files. These checks validate documentation consistency, not executable behavior. No application tests, dependency installation, migrations, external messaging, or deployment were performed.
