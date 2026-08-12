# Implementation Log

**What changed recently, and why.** Append-only; newest entry at the top. This is the second file a
recovering agent reads, after `capability-ledger.md`.

Log an entry when a capability closes, when a decision is made that is not big enough for an ADR but
that future agents depend on, or when a documentation source of truth is corrected.

**Do not log:** routine edits, test output, or anything the git history already answers well.

Format:

```
## YYYY-MM-DD — CAP-NNN <name>  |  <Status>

**Changed:** <behaviour now available, in business terms>
**Files:** <significant paths>
**Rules:** <R-* implemented>
**Decisions:** <decision → where persisted>
**Deferred:** <item → where recorded>
**Notes:** <anything the next agent would be surprised by>
```

---

## 2026-08-12 — CAP-001 Monorepo scaffold + toolchain  |  Implemented

**Changed:** A clean checkout of this repo now runs `pnpm install` and `pnpm build` (worker + web)
to deployable artifacts against Cloudflare Worker bindings, with `pnpm lint`, `pnpm typecheck`,
`pnpm test:unit`, `pnpm test:worker`, and `pnpm exec wrangler deploy --dry-run` all exiting 0.
The Worker entry module (`src/worker.ts`) exports `fetch`, `email`, `queue`, and `scheduled`
handlers, so the "One Worker, multiple entrypoints" shape in
`.claude/rules/architecture.md` §Shape is realized in the deployed bundle, not just asserted in
comments. ESLint enforces three boundary zones (`integrations`, `modules`, `platform`) plus
`import/no-cycle` and a `no-restricted-imports` rule that rejects `hono` from `modules/*`,
`platform/*`, and `packages/*`.

**Files:**
- `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json` (project references)
- `eslint.config.js` (flat config, ESLint 9.39.5; boundary rules above)
- `prettier.config.js`, `.editorconfig`, `.npmrc`, `.prettierignore`, `.gitignore`, `README.md`
- `apps/worker/` — `package.json`, `tsconfig.json`, `tsconfig.node.json`, `wrangler.jsonc` (7
  bindings, `main: src/worker.ts`), `vitest.config.ts`
- `apps/worker/src/worker.ts` — composition module, default-exports `{ fetch, email, queue, scheduled }`
- `apps/worker/src/platform/{env,config,database,object-store,cache,crypto,logger,clock,ids,errors}.ts`
  — `Env` lives in `platform/env.ts` (was previously declared inside the entrypoint, which
  inverted the dependency direction)
- `apps/worker/src/entrypoints/{http,inbound-email,queue,scheduled}.ts`, `apps/worker/src/app-context.ts`,
  `apps/worker/src/http/{router,errors,middleware/*}.ts`
- `apps/worker/src/modules/{identity,onboarding,tenancy,messages,inbound-mail,outbound-mail,provider-sync,attachments,signatures,admin,installation,maintenance}/index.ts`
  — every module is a single empty `index.ts` (the public-surface rule holds by construction)
- `apps/worker/src/integrations/providers/{provider-registry,brevo,resend,cf-sendmail}.ts`,
  `apps/worker/src/integrations/cloudflare/{control-plane,oauth}.ts`
- `apps/web/` — `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` (with `<noscript>`),
  `src/{main.tsx,App.tsx,app/router.tsx,infrastructure/api/client.ts,components/ui/Button.tsx,styles/tokens.css}`
- `packages/{contracts,email-core,config,test-kit}/src/index.ts` + per-package `package.json` and
  `tsconfig.json`
- `migrations/`, `scripts/` — `.gitkeep` placeholders only (CAP-004 / CAP-003 own the content)

**Rules:** No business rules implemented. The capability's job is to enable later rules:
- `R-DATA-004` (PRAGMA foreign_keys = ON) — the D1 binding `env.DB` is declared in `wrangler.jsonc`
  and reachable through `platform/database.ts`. The actual enforcement lands with the first D1
  migration in CAP-004.
- `R-SECRET-*` (ADR-007) — `env.INSTALLATION_TOKEN` and `env.CREDENTIAL_ENCRYPTION_KEY` are declared
  via `secrets_store_secrets`; `AppContext` deliberately does **not** expose `env` (the
  architecture reviewer's H2), so the request-scoped decrypted-credentials chokepoint remains
  enforceable when the credential store lands.

**Decisions:**
- **Worker entrypoint composition.** A single Cloudflare Worker has exactly one default export; to
  support four triggers (`fetch`, `email`, `queue`, `scheduled`) we default-export an object
  combining the four handler methods. The original scaffold named only `src/entrypoints/http.ts`
  as `main`, so `email`/`queue`/`scheduled` were unreachable in the deployed bundle and the
  `queues.consumers` block was orphaned. The fix-pass moved to `src/worker.ts` as `main`.
  → `.claude/rules/architecture.md` §Shape, `docs/rebuild/05-target-architecture/architecture.md:59-66`
- **`Env` lives in `platform/env.ts`.** Originally declared in `entrypoints/http.ts` and imported
  downward by `platform/*`, which inverted the dependency direction. Moving `Env` to `platform/`
  restores `entrypoints ──▶ modules ──▶ domain`. → `.claude/rules/architecture.md` §Dependency direction
- **`AppContext` exposes named collaborators, not `env`.** `buildAppContext(env)` consumes `env` and
  returns `{ db, cache, setupSessionStore, objectStore, config, clock, ids, logger }`. This is the
  chokepoint ADR-007 needs to enforce request-scoped credential caching.
  → `.claude/rules/architecture.md` §Forbidden, ADR-007
- **Provider adapter files are flat (`brevo.ts`) not directories (`brevo/index.ts`).** Diverges
  from `docs/rebuild/05-target-architecture/architecture.md:84-86` which shows directories.
  Reconciled for CAP-001 because the contract explicitly specified flat files and there is no
  content to fill a directory yet. Phase 1 will convert these to directories as the first
  outbound/webhook adapter lands. → `task.md:84` and `architecture.md:84-86`
- **`'hono'` in `no-restricted-paths` is dead code; the real enforcement is `no-restricted-imports`.**
  `import/no-restricted-paths` matches only path-based imports, not bare module names. A
  configuration-only fix added `no-restricted-imports` for `hono` scoped to `modules/*`,
  `platform/*`, and `packages/*`. Verified by injecting and removing a test violation.
  → `eslint.config.js`
- **Full per-pair module-zone enforcement deferred to CAP-003.** The CAP-001 fix-pass landed three
  hard-edge zones (no `hono` in `modules/*`; no `entrypoints`/`http` in `modules/*`; no
  `entrypoints`/`http` in `platform/*`) plus `no-cycle`. The remaining per-pair dependencies
  (the 132 possible `modules/<a> → modules/<b>` edges, of which the table permits ~20) will be
  encoded in `pnpm scaffold doctor` (CAP-003), which is the natural owner.

**Deferred:** Recorded in `docs/rebuild/capability-ledger.md` §Deferred items:
- `vitest@4.1.10` vs `@cloudflare/vitest-pool-workers@0.10.4` peer mismatch — surfaces only when
  CAP-002 turns on real tests. CAP-002 to bump to `@cloudflare/vitest-pool-workers` 0.21.x.
- `wrangler.jsonc` `account_id` placeholder — operator fills in at deploy time (CAP-005).
- Frontend L1/L2/L3 (theme token beyond `prefers-color-scheme`; `body` font token; global
  `:focus-visible` style) — defer to first real feature capability (CAP-006+).
- Logger deny-list for `LogContext` (per code-review L3) and per-level filtering (L4) — defer to
  CAP-016, the first capability that actually emits user-controlled log fields.

**Notes:**
- The four Worker entrypoints (`http.ts`, `inbound-email.ts`, `queue.ts`, `scheduled.ts`) each
  retain their own file but `worker.ts` is the composition point. Per
  `.claude/rules/architecture.md` §Shape, entrypoints are "thin shells" — that holds.
- `inbound-email.ts` now does `message.setReject(REJECTION_REASON)` rather than
  `message.forward(...)`. The handler is reachable end-to-end (verified by `grep` on
  `dist/worker.js`) but inert: no real inbound mail processing until CAP-021.
- No commit was made. The orchestrator is awaiting confirmation per `.claude/rules/git.md`
  ("Agents do not commit or push unless explicitly asked"). The working tree is dirty by design
  and contains ~75 new files.
- `wrangler.jsonc` placeholder IDs (`REPLACE_WITH_*`) are intentional. They make `wrangler deploy
  --dry-run` exit 0 locally and force the operator to substitute real resource IDs at deploy
  time. CAP-005 owns the deploy runbook.

## 2026-08-11 — Repository Agent Operating System established

**Changed:** The repository now carries its own operating rules, roles, procedures, and execution
state, so a new agent session can recover context from the repository alone (`AGENTS.md` §7).

**Files:**
- `AGENTS.md` — entry point: source-of-truth map, non-negotiable rules, session recovery procedure
- `CLAUDE.md` — Claude-specific subagent and tool conventions only; no duplicated project rules
- `.agents/rules/` — architecture, coding, testing, security, documentation, git, agent-collaboration
- `.agents/roles/` — orchestrator, implementer, architecture-reviewer, code-reviewer, qa-reviewer
- `.agents/skills/` — implement-capability, review-capability, phase-audit
- `.agents/templates/` — capability-task, review-report, handoff
- `work/` — active, reviews, investigations, handoffs, archive (+ `README.md`)
- `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md`
- `.gitignore` — `.tmp/`, secrets, build output
- `git init` — the repository was not previously under version control

**Decisions:**
- `docs/rebuild/` is left structurally untouched and remains the design source of truth.
  `.agents/rules/` carries only the *enforceable subset* and links back rather than restating.
  → `.agents/rules/documentation.md` §One fact, one home
- `CAP-NNN` IDs are allocated by the capability ledger, because the specification assigns none.
  IDs are never reused or renumbered. → `docs/rebuild/capability-ledger.md` §Ledger conventions
- `docs/{architecture,business,decisions,operations}/` were **not** created. They would duplicate
  `docs/rebuild/{05,02,09}-*` and become competing sources of truth. Create a `docs/` subdirectory
  only when it has real content with no existing home.
  → `.agents/rules/documentation.md` §Homes
- Security, frontend-reviewer, and four further skills were deliberately **not** created. Empty
  templates train agents to skip the directory. → `.agents/README.md` §Adding to this directory
- Where the roadmap docs disagree with each other, `F-minimal-business-closed-loop.md` §F.1/§F.4 is
  authoritative for Phase 1. → ledger §Known documentation discrepancies

**Notes:** No application code was written. `src/index.ts` is still the placeholder scaffold; the
first real capability is CAP-001 (monorepo scaffold + toolchain), which will replace it.

## 2026-08-11 — Validation pass and fixes

**Changed:** A second agent ran `AGENTS.md` §7 cold, with no prior context, and answered all seven
recovery questions from the repository alone. The procedure works. The same pass surfaced real
defects, all fixed here.

**Files:**
- `.gitignore` — removed stray `/tmp` entry that implied a forbidden scratch location
- `docs/rebuild/README.md` — corrected the phase exit-criteria counts to match the source files
  ("12 boxes" → 11 for Phase 0; "23 boxes" → 29 for Phase 1); replaced the duplicated Rule of
  Three / Rule of One restatement with a pointer to the canonical `.agents/rules/` definitions
- `.agents/rules/architecture.md` — clarified the *intended* reading of "modules never import
  provider SDKs" with "modules may import an *adapter*, not an SDK"; restored the full Forbidden
  list that a partial edit had collapsed
- `.agents/roles/frontend-reviewer.md` — added. Previously listed in `.agents/README.md` as
  "intentionally absent" while the review-capability skill dispatched to it; resolved by adding
  the role with a real (minimal) checklist
- `.agents/README.md` — frontend-reviewer removed from the absent list
- `docs/rebuild/capability-ledger.md` — added discrepancy D-5 (`phase-0-foundation.md` ships with
  acceptance boxes pre-checked, so a fresh agent could conclude Phase 0 is already done; the
  ledger is authoritative)
- `AGENTS.md` §7 — explicitly directs the recovering agent to trust the ledger over the
  pre-checked boxes

**Decisions:**
- The "domain never imports infrastructure" rule, the legacy anti-pattern list, and the module
  layout are deliberately restated in `.agents/rules/architecture.md` from `docs/rebuild/05-*/`.
  The rules file is the *enforceable subset* agents read; the design doc is the full spec. This
  is acknowledged duplication, not a defect — drift is contained by the audit pass at every
  capability close and every phase close.
- Discrepancy D-5 is recorded, not fixed by editing the spec file. The spec is a finalised
  document; the governance layer compensates. Marking it fixed-in-doc would alter the design
  source of truth for cosmetic reasons.
- The audit confirmed all seven recovery questions are answerable; the
  procedure is sound.

**Notes:** Validator's only unfixed concern was the "5-wordings-of-domain-never-imports" issue,
which is acknowledged-duplication: it is the same rule in two roles (rules file + design spec) at
three different levels of detail (sentence, paragraph, full table). This is the intended
hierarchy — navigation (`AGENTS.md`) → rules (`.agents/rules/`) → design (`docs/rebuild/`). A future
audit at a phase boundary will verify they still match.

## 2026-08-11 — Claude Code Hooks (first generation)

**Changed:** The repository now has a deterministic lifecycle guardrail layer around the AI
agent. Six hooks wire into Claude Code's `SessionStart`, `PreToolUse`, `SubagentStart`,
`SubagentStop`, `TaskCompleted`, and `ConfigChange` events. `.claude/settings.json` binds them;
`.claude/hooks/README.md` documents each.

**Files:**
- `.claude/hooks/session-context.sh` — SessionStart, non-blocking. Injects phase + active
  workspace + git state + recent log entry
- `.claude/hooks/protect-destructive-commands.sh` — PreToolUse(Bash), blocking. rm-rf of root
  or home, git reset --hard, git clean -fdx, force-push to main/master/production, DROP
  DATABASE/SCHEMA
- `.claude/hooks/protect-root-pollution.sh` — PreToolUse(Write|Edit|MultiEdit), blocking.
  PLAN.md/NOTES*.md/DEBUG.txt/RESULT.md/etc. at the repo root
- `.claude/hooks/subagent-start-context.sh` — SubagentStart, non-blocking. Common guardrails +
  role-specific appendix for implementer/reviewer/architect/QA/frontend/explore
- `.claude/hooks/validate-subagent-stop.sh` — SubagentStop, blocking. Refuses to let
  implementer-class subagents finish without Status/Files/Tests headings, or reviewers without
  ## BLOCKER/HIGH/MEDIUM/LOW sections
- `.claude/hooks/validate-task-completed.sh` — TaskCompleted, blocking. Refuses to close a
  CAP-NNN with open BLOCKER/HIGH review findings, or with a green-claim that contains FAIL
- `.claude/hooks/protect-config-change.sh` — ConfigChange, non-blocking. Loud audit log when
  governance files change
- `.claude/hooks/lib/log.sh`, `.claude/hooks/lib/project-state.sh` — shared helpers (logging,
  repo-state accessors)
- `.claude/settings.json` — wires the six hooks into their events with precise matchers
- `.claude/hooks/README.md` — the event-purpose-blocking table, payload field map, failure
  behaviour, how to test, and what is deliberately absent
- `.gitignore` — `.tmp/claude-hooks/` added; hook logs are gitignored, the scripts themselves
  are tracked

**Decisions:**
- `set -euo pipefail` is enabled in every script. The implementer habit of running hooks in
  a sandbox where `grep` is wrapped by ugrep-shaped aliases, and where jq rejects payloads
  containing literal control characters, made `pipefail` painful during development. The
  final scripts use jq for input parsing (with `2>/dev/null` on every call) and avoid the
  `(^|\W)` regex shape that ugrep rejects in favour of plain token matches. False-positive
  risk is contained because every script either runs fast enough that a failure is
  acceptable (informational) or matches only high-confidence patterns (blocking).
- `validate-task-completed.sh` does not run `pnpm test` or any other quality gate from inside
  the hook. The hook is fast (jq + grep on small files) and decision-final for the BLOCKER/
  HIGH review case; for "did the tests pass" it relies on the orchestrator's claim plus a
  text-level check that a FAIL token does not appear inside a green claim. Per
  `.agents/rules/testing.md`, real test execution belongs at capability close, not on every
  task completion.
- `protect-config-change.sh` does not block. The governance rule is "prevent accidental
  weakening", not "make immutable". Logging the change loudly is the right enforcement shape;
  the orchestrator's diff review and the rules-change policy in
  `.agents/rules/agent-collaboration.md` are the real safeguard.
- Deliberately NOT wired: `Stop`, `PostToolUse`, `PreCompact`, `PostCompact`, `TaskCreated`,
  `TeammateIdle`. Each was considered and rejected — Stop causes continuation churn,
  PostToolUse adds overhead on every edit, the others have no concrete incident to defend
  against yet.

**Defects found during testing, all fixed before commit:**
- Initial path-resolution in `lib/log.sh` and `lib/project-state.sh` was one level too shallow
  (`../..` from `.claude/hooks/lib/` lands in `.claude/`, not the repo root). Fixed to
  `../../../..`.
- DROP DATABASE inside a quoted shell string was not caught by the original regex because the
  regex required a leading whitespace boundary that did not exist inside the quotes. Fixed
  to a non-word boundary on the left and a non-word-or-end on the right.
- `ps_cap_id_from_text` returned exit-1 on no-match, which `pipefail` propagated into `set -e`
  and silently killed the calling script. Fixed by appending `|| true`.
- The jq extraction in `validate-task-completed.sh` originally had a brittle fallback that
  used `(^|\W)` to anchor a FAIL match; ugrep (the `grep` wrapper that some Claude Code
  environments use) rejected the empty alternative in ERE. Fixed by dropping the boundary
  and relying on the FAIL token alone — keyword detection does not need a regex anchor.

**Defects found by independent audit (post-commit readiness check), all fixed:**
- HIGH: `rm -rf ./build` and `rm -rf ./.git` were over-blocked. Tightened the regex to match
  only when the target is the directory itself (root, home, current, parent, ~user) followed
  by space/semicolon/end — not when it's a specific path inside that directory.
- HIGH: `git push --force-with-lease origin main` was incorrectly blocked. The docs already
  stated `--force-with-lease` is the safe form. Split the regex into two: bare `--force`
  targeting a protected branch blocks, `--force-with-lease` always allows. The block fires
  only when `--force` matches AND `--force-with-lease` does not match.
- MEDIUM: `rm -rf ~root` was under-detected. Replaced literal `~` in the regex with
  `~[^/[:space:]]*` which matches any tilde-prefixed path including `~root`, `~bob`, and
  bare `~`.
- Verification: 20/20 cases PASS in the audit harness at `/tmp/test_drop.py`.

**Notes:** A second agent validated the hooks independently and reported a per-test verdict.
The full report is in `work/reviews/hooks-audit-2026-08-11.md` (created if validation passes
without critical defects; the validator may also report fixes applied inline).

## 2026-08-11 — Claude Code Operating Structure Alignment

**Changed:** The repository's governance was realigned from a "shared multi-tool `.agents/`
layer + Claude Code's own `.claude/`" model to a single Claude Code-centric structure where
**the Main Claude Code session is the sole Orchestrator** and `.claude/` carries every role,
rule, skill, and template the agents read. `AGENTS.md` and `.agents/` were removed; `CLAUDE.md`
became the control-plane entry point.

**Files:**
- `.claude/rules/` — created. 7 rule files moved from `.agents/rules/`: architecture, coding,
  testing, security, documentation, git, agent-collaboration. Internal cross-references updated
  to point at the new location.
- `.claude/agents/` — created. 5 focused agents moved from `.agents/roles/`: implementer,
  architecture-reviewer, code-reviewer, qa-reviewer, frontend-reviewer. Two new agents added:
  **investigator** (read-only evidence-gathering) and **security-reviewer** (auth, secrets,
  webhooks). The `orchestrator` role was **deleted**: the Main Session is the orchestrator; a
  separate orchestrator subagent was duplicate.
- `.claude/skills/` — created. 3 skills moved from `.agents/skills/`: implement-capability,
  review-capability, phase-audit. Two new skills added: **test-business-loop** (verify the
  closed loop on a preview deployment) and **capability-cleanup** (resolve every artifact in
  `work/active/CAP-NNN-*/` to PROMOTE / ARCHIVE / DELETE at capability close).
- `.claude/templates/` — created. 3 templates moved from `.agents/templates/`: capability-task,
  review-report, handoff.
- `CLAUDE.md` — rewritten. Now ~140 lines and explicitly states "Main Claude Code session =
  Project Orchestrator", lists the directory map, the subagent table, the absolute constraints,
  and the state-recovery procedure. Procedure detail is **not** in CLAUDE.md; it lives in skills.
- `.claude/settings.json` — unchanged structurally. No `agent` field; Claude Code uses the Main
  Session by default.
- `.claude/hooks/*.sh` and `.claude/hooks/README.md` — path references updated to `.claude/`;
  the SubagentStop hook adds `investigator` to the exempt list and adds explicit handling for
  `security-reviewer`, `architect-reviewer`, and `frontend-reviewer`. The SubagentStart hook
  adds role-specific blocks for `security-reviewer` and `investigator`. The ConfigChange hook
  adds `.claude/agents/`, `.claude/skills/`, and `.claude/templates/` to its watch list.
- `.gitignore` — single line updated to point at `.claude/rules/documentation.md`.
- `work/README.md`, `docs/rebuild/README.md`, `docs/rebuild/capability-ledger.md` — all path
  references updated.
- `AGENTS.md` and `.agents/` — **deleted**.

**Decisions:**
- The orchestrator role was deleted, not migrated. There is no `.claude/agents/orchestrator.md`
  because there is no separate orchestrator subagent. The orchestrator's responsibilities live
  in three places: `CLAUDE.md` (identity + constraints), `.claude/rules/agent-collaboration.md`
  (coordination constraints), and the skills (procedures). This is the rule from §2 of the
  alignment spec: do not maintain both a Main Session orchestrator and an orchestrator
  subagent.
- The future option (`claude --agent orchestrator`) is preserved in `CLAUDE.md` §Future option.
  Adding an `.claude/agents/orchestrator.md` later is one file; it does not require undoing
  this alignment.
- `business.md` was deliberately **not** added to `.claude/rules/`. There is no business rule
  content that lives outside `docs/rebuild/02-business-discovery/`; the rule files are for
  agent behaviour and architectural constraints, not for business content. Empty rule files
  train agents to skip the directory (the same rule used to skip
  `security-reviewer`/`update-capability-ledger` from the first pass).
- The historical `.agents/` references in this implementation log are **not** corrected — the
  log is append-only history; rewriting it would falsify the trail.

**Notes:** Independent structural review ran after the move. The full audit report is in
`work/reviews/structure-alignment-audit-2026-08-11.md`. Five findings (1 BLOCKER, 2 HIGH,
1 MEDIUM, 1 LOW); all fixed in this same pass:

- **BLOCKER**: stale reference to deleted `.claude/agents/orchestrator.md` in
  `.claude/rules/agent-collaboration.md:22`. Replaced with a pointer to `CLAUDE.md`
  §Execution model.
- **HIGH**: `validate-subagent-stop.sh` required a literal `Tests:` heading but the
  implementer format produces `Tests added:` and `Tests run:`. Regex now matches any of the
  three.
- **HIGH**: `validate-subagent-stop.sh` treated every `general-purpose` agent as an
  implementer, breaking the five roles that share that agent type. The hook now detects
  role from the transcript (via `[role: X]` marker or `.claude/agents/<role>.md` reference)
  and applies the right validation. The Main Session's dispatch convention is updated to
  include `[role: <role-name>]` near the top of each agent's prompt.
- **MEDIUM**: `subagent-start-context.sh` injected implementer instructions to every
  `general-purpose` subagent. The `implementer|general-purpose` case is removed; the
  implementer block now fires only when `agent_type` is literally `implementer`. Other
  roles fall through to the common block and read their own role file.
- **LOW**: `CLAUDE.md` was 126 lines, just past the ~120 target. Trimmed to 108 lines by
  collapsing duplicated prose.

Verification: 24/24 PASS for the end-to-end harness; 20/20 PASS for the destructive-commands
audit harness; 10/10 PASS for the role-detection harness. The Main Session can recover project
state via the procedure in `CLAUDE.md` without spawning any subagent.
