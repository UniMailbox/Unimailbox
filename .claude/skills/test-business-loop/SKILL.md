# Skill: Test Business Loop

Procedure for verifying that a capability or a phase actually delivers the *business* loop end to
end — not just that the unit and unit tests are green. The unit suite can pass while a real user is
still unable to do the thing the capability was meant to enable. This skill is the answer to that
gap.

**Used by:** Main Session (owns the procedure), QA reviewer and investigator subagents (execute
specific steps).

---

## INPUT

- A capability ID whose code is `Implemented` and whose architecture / code reviews are clean, OR
  a phase whose every capability is `Implemented`.
- The phase file in `docs/rebuild/08-roadmap/` (for the phase variant) or `task.md` (for the
  capability variant).
- `docs/rebuild/02-business-discovery/business-rules.md` and `business-glossary.md` — the source of
  what "the loop" actually means in business terms.

## PRECHECK

- [ ] Unit and worker tests pass. **Do not run a business loop test against code that does not
      compile.**
- [ ] All architecture, code, and QA reviews are `ACCEPT` or `ACCEPT WITH FIXES`.
- [ ] No unresolved BLOCKER or HIGH in `work/reviews/`.
- [ ] The auditor (or QA reviewer) did not implement the code under test.

## STEPS

### 1 — Re-state the loop in business terms

Open `docs/rebuild/02-business-discovery/business-rules.md` and the capability's `task.md`. Write
the closed loop as the user would describe it, not as the code is organised. Example: *"A
registration token from the installer lands in the admin's inbox. The admin opens it, lands on
`/setup`, creates the first administrator, sees `/admin`."* If you cannot write the loop without
naming a code path, you are checking the implementation, not the loop.

### 2 — Walk the loop forward, on a preview deployment

For each step in the loop, drive a *real* interaction — curl with a real session, a real browser
session, or the smoke harness. Capture, for each step:

- the actor
- the request (URL, method, body, headers)
- the response (status, body)
- the side effect in the data store (a row inserted, an event written, a credential stored)

The loop is only "complete" when every step succeeded and every step produced an expected side
effect. A 2xx that did not change any data is a finding.

### 3 — Walk the failure paths the business rules require

From `business-rules.md`, identify the failure paths the capability owns. For each:

- drive it (deliberately)
- confirm the user sees a recoverable state, not a stuck one
- confirm no business invariant is silently violated (a half-sent message, an unrecorded send)

### 4 — Walk the unauthorised paths

For each step, also drive it as a non-permitted actor — wrong user, missing role, expired
session. Confirm the system says no, and that the data store did not change.

### 5 — Re-cover the audit trail

After the loop: every state transition should have produced an `audit_events` row. Read the
table; if a transition is missing a row, the loop is incomplete even if everything else
worked.

### 6 — Verdict

- **PASS** — every step succeeded, every failure path is recoverable, every unauthorised path is
  blocked, every transition wrote an audit event.
- **PASS WITH FOLLOW-UPS** — the loop works but a non-blocking gap exists (UX paper cut, missing
  metric). Each follow-up is recorded as a ledger MEDIUM with a reason.
- **FAIL** — any step does not work for a real user; any invariant can be silently violated; any
  transition does not produce an audit event.

---

## VALIDATION

- [ ] Loop stated in business terms, not code terms.
- [ ] Every step driven on a preview deployment with a real interaction.
- [ ] Every failure path the business rules require has been exercised.
- [ ] Every unauthorised path blocked.
- [ ] Audit trail re-covered; every transition has a row.
- [ ] Verdict recorded; any follow-ups are ledger MEDIUMs with reasons.

---

## OUTPUT

```
Capability:  CAP-NNN  |  Phase N
Loop:        <the business loop, in user terms>
Steps:       N walked, N real interactions
Failures:    N walked, all recoverable
Authz:       N paths blocked correctly
Audit:       N/M transitions covered
Verdict:     PASS | PASS WITH FOLLOW-UPS | FAIL

Findings:    <severity-tagged>
Follow-ups:  <item → ledger row>
```