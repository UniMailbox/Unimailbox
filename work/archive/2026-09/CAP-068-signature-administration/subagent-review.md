# CAP-068 subagent review

## Scope and process

A bounded, read-only subagent review covered the core signatures service,
repository, and sanitizer. The reviewer did not edit files or run tests.

The first broad review and a second core-file review timed out and were closed
without a verdict. A narrower review returned the findings below against the
pre-`If-Match` implementation. A final post-fix review was requested but did
not return before shutdown; it is recorded as no conclusion, not as approval.

## Findings and disposition

### High — tenant/IDOR scope (not applicable to this model)

The reviewer observed that `actorUserId` is used for audit/idempotency and not
as a row predicate. The current target model is a single installation with
globally managed domains: `managed_domains` has no tenant/owner column, and
the HTTP route checks `signature.read` / `signature.manage` on every request
before invoking the service. An administrator is intentionally authorized to
manage all installation domains. Adding a nonexistent tenant scope would
diverge from the approved model, so this is closed as not applicable.

### Medium — concurrent update lost-write window (fixed)

The reviewer identified unconditional update-by-id after a read. The final
implementation requires the exact returned `updatedAt` in `If-Match`, advances
the second-precision timestamp strictly, and updates with both `id` and the
expected timestamp. A stale preflight or a conditional-update race returns
`412 STALE_IF_MATCH`; no content, audit, or idempotency row is committed.
The Worker test covers missing and stale `If-Match`; the Web query test covers
header transmission.

## Validation after the fix

- Focused Worker signature routes: 9 tests passed.
- Focused Web signature/admin/router: 61 tests passed.
- Contracts: 386 tests passed.
- Sanitizer unit tests: 3 tests passed.
- Full unit suite: 82 files, 1189 tests passed.
- `pnpm scaffold doctor`, lint, typecheck, format, `git diff --check`, and
  build passed.
- Full Worker suite: 53 files, 913 tests passed against real D1/workerd.
- The first full Worker attempt had transient live-provider/workerd failures;
  the live Brevo/outbound subset then passed 31/31 and the final full run
  passed, with no mock substituted for the provider token.
