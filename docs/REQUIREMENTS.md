# EventBook requirements handoff

## 1. Purpose and authority

Build EventBook, a small event booking application: admins publish events with fixed capacity, visitors browse, and registered users book or cancel a seat. Seats must never be overbooked. Aim for correct, clean, deployed software within the brief's expected **10–14 hours** of effort.

The authoritative source is `Intern_Project_Brief.pdf` in this directory (four pages). This document translates the full brief into an implementation handoff. Required scope, optional bonuses, and open decisions are identified separately. If interpretation differs, consult the PDF and record the resolution.

### Working roles

- **Human developer:** owns product choices, understands the implementation, reviews the work, and completes participation confirmation and submission. Be ready to explain the project in a short walkthrough if shortlisted.
- **Team lead assistant:** communicates requirements, decisions, and review feedback through Markdown.
- **Implementation agent:** plans the schema, REST API, and implementation; builds and verifies the application; records actual decisions and limitations in project documentation. Keep progress and unresolved decisions reviewable in Markdown.

This handoff defines requirements only. Proposed schema, endpoints, authentication mechanics, and other implementation choices are recorded in `TECHNICAL_DESIGN.md`; they are design decisions rather than additional brief mandates.

## 2. Deadlines and priorities

All deadlines below are **Nepal Time (NPT, UTC+05:45)** as specified in the PDF:

| Milestone | Deadline |
| --- | --- |
| Reply to confirm participation | Friday, 16 October 2026, 6:00 PM NPT |
| Reply to the original email with the submission | Sunday, 18 October 2026, 6:00 PM NPT |

Keep the deployed application live for **at least two weeks after submission**. If submitting at the deadline, that means through at least 1 November 2026, 6:00 PM NPT.

Evaluation priorities, in descending order:

1. Correct features and rules on the live site (biggest weight).
2. Sensible data model and API, clean and consistent code, and absence of unused or unexplainable material.
3. Security and validation.
4. Frontend UX.
5. README, Git history, and tests.

If time is short, prioritize **login → booking rules → admin event management → frontend polish**. Submit working deployed parts by the deadline even if incomplete; describe missing work honestly under README known issues and next steps. A smaller working app is preferable to a larger broken one.

## 3. Required architecture and stack

| Layer | Requirement |
| --- | --- |
| Frontend | Next.js + TypeScript. Any styling approach. |
| Backend | Separate REST API using **Python + FastAPI, confirmed by the user**. This is a permitted option in the brief, which prefers Node.js + Express and also allows Django REST Framework. |
| Database | Supabase PostgreSQL for deployment; plain PostgreSQL in Docker Compose locally, using the same application schema and migrations. |
| Local development | **Docker Compose, selected by the user.** The PDF lists it as a bonus; it is required for this project's chosen scope. |
| Authentication | Registration and login implemented in the application's own backend, rather than Supabase Auth. |

The Next.js app calls the REST API; only the backend communicates with Supabase. Use Next.js for frontend responsibilities only: **no Next.js API routes or server actions as the backend, and no Supabase queries from Next.js**. Never expose a Supabase service-role key in frontend code.

The user has selected FastAPI and Docker Compose local development. Preserve those choices in subsequent documents. Compose must run Next.js, FastAPI, and local PostgreSQL with documented environment setup, persistent data, hot reload, explicit migrations/seeding, and an isolated test database. A full local Supabase stack is unnecessary; deployment still uses Supabase PostgreSQL.

## 4. Required capabilities by role

### Visitors

- Browse upcoming events without logging in.
- See remaining seats for each event in the listing.
- Search events by title.
- Navigate a list paginated by the server. Fetching all events and slicing them in the frontend does not satisfy this requirement.
- Open an event to view its full details.

### Registered users

Normal (non-admin) users:

- Register, log in, and log out.
- Book one seat for an event per booking.
- View their own bookings.
- Cancel an eligible booking they own.

### Admins

- Create, edit, and delete events.
- Each event has at least a title, description, date and time, venue, and total seats.
- View who booked a given event.
- Receive an admin account created through the seed script. Nobody may grant themselves admin status through the app.
- Are management-only: admin accounts cannot book events, view a personal booking history, or cancel bookings. Those endpoints return 403 for admins; the admin panel is their interface.
- Cannot edit or delete events that have started (backend returns 409); started events are preserved as read-only history while details and attendee lists stay readable. This is a user-selected edge-case policy, not an explicit PDF requirement.

**User-selected frontend robustness (not PDF requirements):** the frontend additionally (a) reflects event-start eligibility in the UI, disabling booking and cancellation at or after `starts_at` with an explanation and updating as time passes without a reload, while the backend clock stays authoritative; (b) after a lost booking response, scans the actor's complete booking history before reporting a definite absence, and reports an uncertain outcome when that verification fails, never auto-retrying the booking; and (c) guards asynchronous auth work with an operation generation so a delayed restoration or logout for a previous account cannot overwrite or clear a newer login.

## 5. Mandatory backend rules

Enforce every rule in the backend, including when callers bypass the UI and use curl or Postman:

| ID | Rule | Observable result |
| --- | --- | --- |
| B1 | A user cannot book the same event twice unless their earlier booking was cancelled. | A duplicate active booking fails; booking again after cancellation is allowed if the event remains eligible and has capacity. |
| B2 | An event cannot be overbooked. | Accepted bookings never exceed the event's total seats; a full event rejects another booking. |
| B3 | Past events cannot be booked, and their bookings cannot be cancelled. | Both operations fail when the event is in the past. |
| B4 | Users can cancel only their own bookings; cancellation frees the seat. | Another user's cancellation request fails; an eligible successful cancellation restores availability. |
| B5 | An admin cannot reduce total seats below the number already booked. | Such an edit fails without leaving invalid capacity. |
| B6 | Only admins manage events or see attendee lists. | Unauthorized callers cannot create, edit, delete, or access attendee data. |

**Concurrency scope:** B2 is mandatory. The brief separately lists explicit safe handling of two users booking the last seat simultaneously, plus an explanation of how, as a bonus. Preserve that distinction in planning and reporting: never treat overbooking as acceptable, and do not present the dedicated simultaneous-last-seat demonstration/explanation as a separate mandatory deliverable.

Choose behavior for uncovered edge cases, especially deleting an event with existing bookings. Implement it consistently and explain the choice in the README. The brief does not prescribe a deletion policy.

## 6. Security, validation, and errors

- Hash passwords.
- Protect restricted API operations with backend authentication and authorization.
- Prevent self-promotion to admin, including through direct API input.
- Keep secrets in environment variables; never commit `.env`. Commit `.env.example` with the configuration needed to run the project and without real secrets.
- Validate inputs on the server.
- Return sensible HTTP status codes and clear errors without leaking stack traces.
- Keep database access and privileged Supabase credentials on the backend, consistent with section 3.

Follow the proposed authentication/session mechanism and error format in `TECHNICAL_DESIGN.md`, recording justified changes there. The brief itself does not mandate JWT, cookies, specific password libraries, or particular status-code mappings.

## 7. UX and code quality

- Make the application usable on a phone.
- Show loading, error, and empty states; avoid blank screens and silent failures.
- Give clear feedback when actions fail, including a full event.
- Keep navigation, patterns, and implementation simple and consistent.
- Ensure features presented by the UI actually work against the backend.
- Remove unused files, dead code, commented-out blocks, and leftover boilerplate.
- Keep the code explainable by the human developer; avoid unnecessary complexity for this small scope.
- Commit incrementally with meaningful messages. The brief flags a history of only 1–3 giant commits as a red flag. The implementation agent must follow the workspace's authorization rules for committing and arrange incremental human commits if it cannot commit directly.

## 8. Seed data

Provide a runnable seed script that creates:

- One admin account.
- One normal user account.
- Enough sample events to exercise server pagination and the booking rules.
- A past event.
- A nearly full event, with the booking data needed to make that state real.

Seed the live database so evaluators can log in immediately using the admin and user credentials documented in the README. Account creation must preserve the restriction against public admin registration. Exact sample content, counts beyond those above, and seeding mechanics are implementation choices.

## 9. Verification

Provide **at least three automated backend tests** covering the most important business rules. The test suite must run with one documented command. Choose meaningful cases and record what they cover; the brief does not mandate a specific test framework or three particular rules.

Also verify the full acceptance checklist in section 14, including API calls that bypass frontend restrictions. Use Postman or equivalent direct API checks where useful. Record any failing or incomplete behavior honestly. A dedicated simultaneous-last-seat test/demonstration belongs to the optional concurrency bonus; mandatory capacity correctness still applies.

## 10. Deployment requirements

Deployment is **compulsory**. Submissions without a working live link will not be reviewed.

- Deploy a working frontend, REST backend, and Supabase PostgreSQL database.
- Use any suitable hosts. The brief offers Vercel or Netlify for the frontend and Render or Railway for the backend as examples, not required choices; free tiers are sufficient.
- Seed the live database and verify both test accounts.
- Supply both live application and API URLs.
- Keep the deployment available for the retention period in section 2.
- If a free backend sleeps and its first request is slow, explain that in the README; the brief permits this behavior.

Plan an early deployment and leave time to resolve deployment issues. This requirements-writing task does not authorize deployment or external messages; the human developer coordinates those actions during implementation and submission.

## 11. Required README and submission

Write a concise README in the developer's own words that matches the actual code. Cover every item below:

| Topic | Required content |
| --- | --- |
| Live links and test accounts | Application URL, API URL, admin login, normal user login. |
| Tech stack | Actual choices and why. |
| Run locally | Docker Compose setup/start/stop, environment examples, migration/seed/test commands, and volume persistence/reset behavior. Compose coverage is a user-selected addition. |
| Data model | Actual tables and the reasoning behind them. |
| API | Brief description of actual endpoints. |
| Decisions and trade-offs | Seat counting, uncovered edge cases such as booked-event deletion, and other important design decisions. |
| AI usage | Honest disclosure of which AI tools were used and for which parts. |
| Known issues / next steps | Actual limitations, incomplete work, and how missing parts would be built. |

Include the backend sleep note if applicable. Avoid a long generic README that does not reflect the implementation. AI assistance is permitted, but the human developer must understand and be able to explain the code.

Before the submission deadline, the human developer replies to the original email with the live application URL **and API URL**, the GitHub repository link, and the README coverage above. The repository must be public or the evaluators must be invited. External email and repository invitations remain human-coordinated actions.

## 12. Developer-owned design choices

The brief delegates these choices to the developer. Current proposals are in `TECHNICAL_DESIGN.md` and their execution tasks are in `IMPLEMENTATION_PLAN.md`; they are not all still unresolved. Follow those proposals or record justified revisions, and document important actual outcomes in the README:

- Data model, tables, relationships, booking/cancellation representation, and remaining-seat calculation.
- REST routes, request/response shapes, error format, and pagination/search contract.
- Authentication and logout/session behavior consistent with custom backend auth.
- Pages, navigation, styling, folder structure, and libraries.
- Date/time interpretation and the precise past-event boundary, consistently enforced by the backend.
- Handling deletion of events with bookings and other uncovered edge cases.
- Hosting providers and deployment setup.
- Which backend rules receive the required automated tests.
- Whether time remains for optional bonuses after required functionality works.

Do not add unrelated mandatory scope such as payments, notifications, ticket delivery, or a particular schema/API design. The brief intentionally delegates design choices to the developer and evaluates the reasoning.

## 13. Brief bonuses and selected scope

The PDF lists all three as bonuses. The user's later choice makes Docker Compose required for this project; the other two remain optional after required work functions:

1. Safely handle two users booking the final seat simultaneously and explain the mechanism.
2. **Selected user requirement:** Docker Compose local development as defined in section 3 and `TECHNICAL_DESIGN.md`.
3. Login rate limiting.

Track optional bonuses separately from required completion. Neither bonuses nor selected Compose tooling replace mandatory features, security, tests, deployment, or documentation.

## 14. Acceptance checklist

Use this as the completion gate, with evidence from the live application, direct API checks, test output, and repository documentation:

- [ ] Public visitors can browse upcoming events, see seats left, search by title, use server pagination, and open event details.
- [ ] Registration, login, logout, booking, own-bookings display, and eligible cancellation work on the live site (normal users; admins receive 403 on booking endpoints).
- [ ] Duplicate active bookings, full-event bookings, and past-event bookings fail with clear messages.
- [ ] Rebooking after cancellation works when otherwise eligible; cancellation frees a seat.
- [ ] Past-event cancellation and cancellation of another user's booking fail through the API.
- [ ] Admins can create events, edit and delete future events, and view attendees; required event fields are present. Started events are read-only.
- [ ] Unauthenticated callers and normal users cannot perform admin operations or access attendee lists through direct API calls.
- [ ] Capacity cannot be reduced below existing bookings, and accepted bookings never exceed capacity.
- [ ] Public app/API operations cannot make a user an admin; the admin is seeded.
- [ ] Booked-event deletion behavior is implemented and explained.
- [ ] Passwords are hashed, input is validated server-side, errors use sensible statuses and contain no stack traces, and protected operations enforce access rules.
- [ ] Frontend and backend are separate; Next.js uses the REST API and performs no Supabase queries or backend API-route/server-action work.
- [ ] Mobile use, loading/error/empty states, and failed-action feedback are usable.
- [ ] Seed data includes both accounts and enough events for pagination, including a past and nearly full event; live credentials work.
- [ ] At least three meaningful automated backend tests pass with one documented command.
- [ ] User-selected Docker Compose runs frontend, backend, and local PostgreSQL with hot reload and persistent data; explicit migrations/seeding and isolated database tests work as documented.
- [ ] `.env` is absent from the repository; `.env.example` exists; secrets and the Supabase service-role key are absent from frontend code.
- [ ] Live application and API links work, and availability is arranged for at least two weeks after submission.
- [ ] README covers every topic in section 11, reflects actual behavior, and discloses AI use and known issues.
- [ ] Code is consistent and explainable; unused material is removed; Git history shows meaningful incremental work.
- [ ] Submission materials are ready before the exact deadline, with evaluator repository access.

## 15. Suggested delivery sequence

The brief suggests this sequence; it is guidance rather than a new deadline schedule:

1. **Day 1:** design the model, build custom auth and the backend rules, create the seed script, and check the API with Postman.
2. **Day 2:** build the Next.js + TypeScript frontend, connect it to the API, and deploy an initial working version early.
3. **Day 3:** run tests, fix issues, polish, finalize deployment and README, and leave deployment buffer time.

Implementation is complete when all required acceptance items have evidence. If time runs out, submit the working deployed parts on time and explicitly document remaining gaps; that is an incomplete submission, which the brief permits. Record actual choices and verification results in Markdown so the team lead and human developer can review the handoff without reconstructing chat history.
