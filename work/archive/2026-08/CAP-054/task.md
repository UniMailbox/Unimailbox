# CAP-054 — Provider idempotency on the Brevo HTTP send

**Phase:** 2 — Reliable Business Loop (verification re-open, D-CAP-028-E)
**Goal:** Put the canonical message-id provider idempotency key on the real Brevo HTTP send so a
Worker crash after provider acceptance but before D1 success can never double-send the same
message. The queue already constructs the right value (`idempotencyKey: claimed.message_id`); the
Brevo adapter drops it.

## Background

Brevo expects the idempotency value in the **sendTransacEmail JSON body**, not in a fetch
`RequestInit.headers` HTTP header. The official contract:
`https://developers.brevo.com/reference/sendtransacemail` (sendSmtpEmail → `headers` JSON object).

The existing preview-gate AC 5 wire-shape assertion probes `sendInit.headers['X-Idempotency-Key']`,
which is the wrong layer. The correct assertion parses `sendInit.body` and reads
`body.headers['Idempotency-Key']`.

## Scope

### In scope
- `apps/worker/src/integrations/providers/brevo.ts` — include `Idempotency-Key` in the payload's
  `headers` JSON object; preserve `Message-ID` / `In-Reply-To` / `References`; do not move
  `Idempotency-Key` into `RequestInit.headers`.
- `apps/worker/src/integrations/providers/brevo.test.ts` — adapter unit coverage proving the
  payload shape (success path was previously unproven).
- `apps/worker/test/preview-gate.worker.test.ts` — AC 5 wire-shape test converted from `liveOnly`
  to a normal `it()`. The test already mocks `globalThis.fetch` and uses a literal encrypted
  credential — it does not depend on a real `BREVO_API_KEY`. Drop the `liveOnly` helper and the
  `beforeAll` warning machinery that becomes unused.

### Out of scope
- Touching `processOutboundJob` — it already passes `idempotencyKey: claimed.message_id` and is
  green in the unit suite.
- Touching `SendProviderMessage` contract shape — already carries `idempotencyKey`.
- Touching the audit chain, idempotency records, or webhook paths — no audit-relevant state
  transition changes.
- Any Brevo Resend/CF-Sendmail adapter — they do not exist yet; the rule is scoped to Brevo.
- Any new migration, dependency, secret, or env var.

## Business rules cited

| Rule | Meaning for this slice |
|---|---|
| `R-OUTBOUND-004` | Provider calls use the canonical message ID as their idempotency key so a redelivery cannot double-send. The Brevo adapter MUST transmit it. |
| `R-OUTBOUND-006` | Multi-row writes that must be atomic go in a single D1 batch. Untouched by this slice — the send is one HTTP call, not a batch. |
| `R-SECRET-003` | Secrets are never logged, returned in API responses, or sent to the client. The unit test uses a literal `BREVO_API_KEY: 'test-key'` value (not a real key) and asserts nothing about its contents. |
| `R-LOG-001` | One JSON line per event; never log passwords, hashes, tokens, message bodies, attachment bytes, decrypted secrets, provider API keys, or `Idempotency-Key` values tied to a body. |

## Acceptance criteria

1. **Brevo JSON payload always includes** `headers['Idempotency-Key'] === msg.idempotencyKey`
   (the canonical message ID). Pinned by the new unit test in `brevo.test.ts` AND by AC 5 in
   `preview-gate.worker.test.ts`.
2. **`Message-ID`, `In-Reply-To`, `References` coexist with `Idempotency-Key`** when supplied.
   Pinned by the unit test "all headers present" case.
3. **`Idempotency-Key` is present even when `msg.messageId` is undefined.** Pinned by the unit
   test "idempotency key without messageId" case.
4. **`Idempotency-Key` is NOT in `RequestInit.headers`.** Pinned by the unit test assertion that
   `fetchInit.headers` does not carry it; the previous AC 5 assertion at the wrong layer is
   removed.
5. **No secret values** may appear in source, tests, snapshots, logs, commits, or reports. The
   test uses `BREVO_API_KEY: 'test-key'` (a literal placeholder, not a real key).
6. **The queue continues to use the canonical message ID** as `idempotencyKey`. Verified by
   reading `processOutboundJob` after the slice (no code change; the diff confirms).
7. **The wire-shape test runs without `BREVO_API_KEY` or any real provider call.** The fetch spy
   intercepts the outbound HTTP request before it leaves the Worker. No `.env` file is read.
8. **Standard and configured-local test behavior no longer differ** for the wire-shape
   assertion: AC 5 runs in both modes.
9. The local gates below establish CAP-054 as **Implemented**. Phase 2 may return to `Verified`
   only after the project-level ledger requirement is met: this revision is deployed to preview and
   a controlled same-key retry/duplicate-send observation confirms provider-side suppression. Local
   review and `pnpm scaffold doctor`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`,
   `pnpm test:unit`, `pnpm test:worker`, `pnpm build`, and `git diff --check` remain required before
   that operator step.

## File ownership

| File | Writer |
|---|---|
| `apps/worker/src/integrations/providers/brevo.ts` | CAP-054 implementer (this slice) |
| `apps/worker/src/integrations/providers/brevo.test.ts` | CAP-054 implementer (this slice) |
| `apps/worker/test/preview-gate.worker.test.ts` | CAP-054 implementer (this slice — only AC 5 / `liveOnly` / `beforeAll` machinery in scope) |
| `docs/rebuild/capability-ledger.md` | Orchestrator on Phase 2 close |
| `docs/rebuild/implementation-log.md` | Orchestrator on Phase 2 close |

## Reference implementation

`https://developers.brevo.com/reference/sendtransacemail` (official Brevo API contract).
Provenance recorded in `apps/worker/src/integrations/providers/brevo.ts` header comment.

No Agentic Inbox pattern is used. The Brevo adapter is the canonical reference implementation
because Brevo is the contract owner for its own API.

## Quality gates

A capability is `Implemented` only when every gate below passes locally:

```bash
pnpm scaffold doctor   # 14/14
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test:unit
pnpm test:worker
pnpm build
git diff --check
```

Focused commands (run first, rerun after each fix group):

```bash
pnpm exec vitest run apps/worker/src/integrations/providers/brevo.test.ts
pnpm exec vitest run --project workers apps/worker/test/preview-gate.worker.test.ts
```

Expected Worker baseline after the slice: at least 784 passed (was 783 + 1 intentional skip; the
skip becomes a real run), zero skipped, zero failed.

## Delivery path

A user-driven path is not in scope for this slice (no UI surface changes). The production fix
takes effect on the next outbound send after the slice is deployed: `processOutboundJob` already
calls `brevoAdapter.send(...)` with `idempotencyKey: claimed.message_id`. After the slice, the
HTTP request body carries that value in `headers['Idempotency-Key']`; a controlled preview
redelivery with the same key must still be observed before claiming that Brevo dedupes it.

## Out-of-scope (explicit, non-overlapping follow-ups)

- D-CAP-029-A (atomic webhook-delivery INSERT + messages UPDATE) — unchanged.
- D-CAP-029-B (logger chain-walking guardrail) — unchanged.
- D-CAP-031-A (per-provider webhook size cap) — unchanged.
- CAP-047 (drafts + attachments, Phase 3) — unblocked after Phase 2 close.

## Stop conditions

- Master / worktree dirty or diverged.
- CAP-054 / path already exists (precondition check failed).
- A real provider call or deployment becomes necessary.
- Any gate remains red after focused diagnosis.
- Phase 2 cannot honestly be restored to Verified.
