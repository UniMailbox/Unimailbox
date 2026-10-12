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

## Remaining acceptance

No live model/account inference, remote migration, deployment, real-provider
structured output or email delivery using generated content was performed.
Migration 0034 must be applied before deploying the new Worker. Native Workers AI
requires the configured AI binding; SDK backends require an administrator-owned
credential. Real provider/model compatibility and output quality require explicit
runtime acceptance. Feature source is committed as `850e0d7`; staging publication
and remote migration acceptance are pending the release workflow.
