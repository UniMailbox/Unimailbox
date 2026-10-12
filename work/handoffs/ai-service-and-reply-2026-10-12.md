# AI service, administration and email reply

## Scope

One shared non-streaming AI service supports native Workers AI, Anthropic
Messages SDK and OpenAI Chat Completions SDK, with protocol-specific compatible
HTTPS backends. Administrators configure model, endpoint, encrypted credentials,
token limit and timeout in an independent `/admin/ai` menu. Schema migration
0034 seeds the disabled service. Native AI binding remains optional.

The composer offers AI reply for an original message and AI draft for new mail.
Instructions and the current draft feed a plain-text preview; insertion requires
explicit confirmation and preserves recipients, subject, threading and attachments.
The operation does not send mail. Source mail is read server-side with global and
mailbox read/send permissions, including on replay. Paid inference reserves its
idempotency key before the upstream call; outcome plus content-free audit settle
atomically. There are no automatic frontend or SDK inference retries.

See [owning design](../../docs/rebuild/18-ai-service-foundation.md) for bounds,
credential-change semantics, reservation retention, cancellation and privacy.

## Evidence

- `pnpm verify`: doctor 14/14, generated binding check, ESLint, TypeScript,
  web/Worker build dry run; 1,305 unit/frontend/contract/script tests,
  971 Worker tests and 23 migration fixtures passed (2,299 total).
- Real local workerd/D1 tests cover configuration encryption, permission matrix,
  revoked membership, cross-mailbox source rejection, caller-deleted messages,
  same-key replay/conflict, concurrent reservation, sanitized upstream failure,
  audit settlement rollback and output bounds. SDK HTTP responses and native
  binding responses are synthetic.
- Browser checks at desktop and 390-pixel mobile width use local synthetic API
  responses. Independent navigation/configuration and reply preview work; the real
  Tiptap editor keeps its existing body until Replace body, then inserts escaped
  text and retains the recipient/subject. No message was sent by these checks.
- Final copy and redundant test-fixture cleanup received focused configuration/
  settings tests and static checks after the full gate.

## Staging publication

User-authorized `pnpm deploy:staging` deployed revision `5f85a35` as Worker version
`e4981bdf-2992-4794-8e9d-783263925e3d` at
[staging](https://staging.unimailbox.tech). The repeated release gate passed 2,300
tests (1,305 unit/frontend/contracts/scripts, 971 Worker, 24 migration fixtures).
All 34 remote schema companions and release smoke passed. Health/readiness match
the published revision/tree and schema 0034. Native Workers AI binding is present;
configuration revision 0 is disabled and has no API key. Both AI endpoints reject
unauthenticated requests with 401. See [QA](../../docs/qa/ai-staging-2026-10-12.md).

The first release stopped before Worker publication because migration 0034 did
not register itself. The fix adds tracking and allows safe partial/repeat SQL
application; regression tests execute raw SQL without fixture-added tracking.
The subsequent canonical release recovered successfully.

## Remaining acceptance

No live model/account inference, real-provider structured output or email delivery
using generated content was performed. Enable a configured model in Admin → AI
services for runtime acceptance. SDK backends require an administrator-owned
credential. Real provider/model compatibility and output quality remain open.
Feature source is committed as `850e0d7`, with migration fix `5f85a35`.
