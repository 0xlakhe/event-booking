# Coding and handoff guidelines

## Read the relevant sources

- Before implementation or review, read `docs/REQUIREMENTS.md` for scope and acceptance criteria, `docs/TECHNICAL_DESIGN.md` for chosen contracts, and the current task in `docs/IMPLEMENTATION_PLAN.md` for deliverables and verification.
- Before continuing work, read `docs/PROGRESS.md` for actual evidence, remaining work, and the current review checkpoint. Distinguish reported results from independently verified results.
- Preserve the agreed Next.js + TypeScript frontend, separate FastAPI backend, Docker Compose local PostgreSQL, and production Supabase PostgreSQL. Follow the documents for architecture and security details rather than duplicating or reinterpreting them here.
- Stay within the requested task and existing review checkpoints. A review-only request remains read-only; later milestones and unrelated refactors are separate work.

## Readable code and focused modules

- Prefer straightforward control flow, descriptive names, explicit types at module interfaces, and small functions with one coherent responsibility. Optimize for a human being able to explain the code.
- Group behavior and its invariants in focused modules. Keep interfaces small and hide transaction, persistence, and validation details behind the module that owns them.
- Keep `backend/app/main.py` focused on application assembly and route wiring. Substantial database readiness logic belongs in a focused module with a small callable interface. This is general separation guidance, not an instruction to refactor existing code during an unrelated task.
- Make dependencies explicit through function arguments or framework dependency injection. Avoid hidden mutable state that can mix application configurations, database targets, or test environments.
- Remove unused code and redundant wrappers. Extract repeated knowledge when it improves clarity; similar-looking code alone does not justify a shared abstraction.

## Apply SOLID pragmatically

- **Single responsibility:** separate code that changes for different reasons; keep business rules out of application assembly and UI event handlers.
- **Open/closed:** introduce an extension point when a real variation needs it. Do not design plugin systems for imagined features.
- **Liskov substitution:** where implementations share a contract, preserve expected inputs, outcomes, errors, and invariants. Prefer composition when inheritance would break those expectations.
- **Interface segregation:** expose only what callers need; avoid large interfaces that force unrelated dependencies together.
- **Dependency inversion:** let business behavior receive the dependencies it needs through clear interfaces. Ordinary functions and modules often suffice; use classes, protocols, or adapters when actual variation or testing needs earn them.

Use these principles to make code easier to read and change, not to maximize layers. Avoid needless classes, generic repositories, pass-through services, or one-implementation interfaces. Document justified deviations and their reasons in the technical design/progress when they affect an agreed contract; do not silently change scope or behavior to satisfy a pattern.

## Verification and progress

- Test meaningful observable behavior and failure cases through module/HTTP interfaces. For a bug fix, include a regression that fails for the original behavior; avoid tests that merely repeat implementation details.
- Use real PostgreSQL when correctness depends on its constraints, transactions, privileges, or concurrent writes. Keep test data and credentials isolated as specified in the design.
- Keep fakes faithful to the behavior relevant to a test. A passing simulated test is not evidence that a live database, deployment, or user flow works.
- Run checks appropriate to the changed behavior and record exact commands, actual results, limitations, and justified decisions in `docs/PROGRESS.md`. Follow the plan's completion criteria; distinguish implemented, verified, deferred, and unverified work.
- Keep documentation consistent with actual files and results. Apply these standards within the active task; these instructions do not themselves change any milestone status. The independent review below is a user-requested verification step; existing human/team-lead approval checkpoints remain unchanged.

## Milestone review

- After implementing each active milestone, launch a fresh reviewer subagent before marking it complete. Give the reviewer a self-contained brief: milestone scope and acceptance criteria, relevant sections of `docs/REQUIREMENTS.md`, `docs/TECHNICAL_DESIGN.md`, and `docs/IMPLEMENTATION_PLAN.md`, applicable `AGENTS.md` instructions, the diff or changed-file list, and specific review goals.
- The reviewer independently reads actual code and relevant documentation, checks behavior against the milestone, and verifies meaningful failure/regression coverage. Challenge assumptions about PostgreSQL constraints, transactions, privileges, and concurrency when relevant. Treat the builder's report as claims to verify, not evidence of success. Review remains read-only except for safe tests against independently validated isolated targets; never mutate development/production data.
- The builder fixes concrete findings within the milestone and requests reviewer rechecks of the corrections until no blocking findings remain. Blocking means a demonstrated correctness, security, or acceptance-criterion failure. Record minor suggestions without making zero suggestions a completion requirement or expanding into unrelated review churn.
- Record reviewer identity, findings/severity, corrections, actual verification commands/results, limitations, and review outcome in `docs/PROGRESS.md`. Distinguish independently verified evidence from builder-reported evidence. Keep the milestone incomplete while blocking findings remain; report unresolved blockers honestly.
- If subagents are unavailable or review cannot finish, report that limitation and preserve the current checkpoint. Never fabricate a reviewer, verification run, or approval; independent review remains an unmet completion criterion.
- Reviewer acceptance completes this verification step only. It does not replace human/team-lead review, authorize the next milestone or external actions, permit unsafe tests, or expand the requested scope.
