# AI service foundation

The installation has one active, global AI configuration at a time. Administrators
select the API protocol independently of the vendor name. The first consumer is
email reply/draft assistance. AI starts disabled and requires an explicit
administrator save; inference runs only after a user selects Generate.

## Configuration

Open **Admin → AI services** (`/admin/ai`). Select the protocol, model ID,
base URL, output token limit and timeout. The model must support text generation.
`settings.read` permits reading metadata; `settings.manage` permits saving.

| Protocol | Transport | Default base URL | Credential |
| --- | --- | --- | --- |
| `workers-ai` | Native `env.AI.run()` | None | Worker AI binding |
| `anthropic` | Official Anthropic SDK, Messages | `https://api.anthropic.com` | API key |
| `openai` | Official OpenAI SDK, Chat Completions | `https://api.openai.com/v1` | API key |

Compatible services can use a custom HTTPS SDK base URL. OpenAI appends
`/chat/completions`; Anthropic appends `/v1/messages`. For example, an Anthropic
proxy serving `/proxy/v1/messages` needs base URL `https://host.example/proxy`.
URLs cannot contain credentials, query strings or fragments. Compatibility means
support for the selected endpoint and request fields, not every provider feature.
The OpenAI adapter uses `max_completion_tokens` for the output limit.

API keys use the existing `CREDENTIAL_ENCRYPTION_KEY` and AES-GCM helpers.
`ai_configuration` owns configuration, encrypted bytes, IV, authentication tag and
revision; it does not share outbound email credentials. No API returns plaintext
keys or encrypted bytes. Key omission preserves the current key only for the same
protocol and base URL; `null` removes it; a string replaces it. Changing protocol
or URL clears the old key unless a new one is supplied. Workers AI always clears
keys and rejects a supplied key. Removal of the key requires disabling the SDK
backend. Saving does not make an inference call.

`GET /api/v1/admin/ai` returns `{ data: { configuration, revision, hasApiKey,
workersAiAvailable, canManage } }`. `PUT` accepts `{ configuration, apiKey? }` and
requires `If-Match: <integer revision>` plus `Idempotency-Key`. Credential changes,
configuration changes, revision comparison, audit and replay evidence form one D1
batch. Stale writes return `412 STALE_IF_MATCH`. Replay and audit contain safe
metadata only; responses use `Cache-Control: no-store`.

## Business integration

The composition root exposes `buildAppContext(env).ai`, implementing the neutral
`AiService<AbortSignal>` contract. The `ai` module owns inference orchestration and
accepts a configuration loader plus adapters; it never imports provider SDKs or
admin repositories. The admin module owns persistence. Provider SDKs and native
binding calls live in `integrations/ai/registry.ts`.

```ts
const response = await buildAppContext(env).ai.generate({
  system: 'Return a concise answer.',
  messages: [{ role: 'user', content: 'Hello' }],
  output: { type: 'text' },
}, { signal: abortController.signal });
```

The result contains `protocol`, `model`, `text`, `json`, `finishReason` and
`usage: { inputTokens, outputTokens }`. Missing native usage is `null`, not zero.
Native Workers AI does not reliably supply a finish reason, so it is `null`.
For plain-text generation, adapters remove inline `<think>…</think>` reasoning
before returning the result. Nested, case-insensitive and unfinished blocks are
handled; reasoning-only or orphan-closing-tag output fails as `AI_INVALID_RESPONSE`.
This ensures composer preview/insertion and new idempotency records contain only
the final body. Separate SDK reasoning fields/blocks are never merged into text.
Structured JSON retains literal tag strings and still requires schema validation.

Structured output is requested per business call, not as a global business schema:

```ts
output: {
  type: 'json_schema',
  name: 'answer',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
}
```

The adapter sends the provider's native structured-output fields and checks the
returned JSON with `@cfworker/json-schema` (draft-07, without dynamic code compilation). Use the schema subset supported by the selected
model and provider; support varies by model and compatible proxy. Invalid JSON,
schema violations, empty output, known truncation and refusals fail explicitly.
There is no silent prompt-only fallback. This phase handles non-streaming text
and object JSON output only; tools, images, embeddings, streams, Responses API and
vendor-specific reasoning options are future extensions.

All SDK retries are disabled. Callers receive stable `AI_DISABLED`,
`AI_NOT_CONFIGURED`, `AI_UPSTREAM_ERROR`, `AI_TIMEOUT`, `AI_CANCELLED` or
`AI_INVALID_RESPONSE` codes. Raw SDK errors are discarded because they can contain
prompts, headers or upstream response bodies. HTTP callers must enforce business
and mailbox authorization before reading mail or calling this service. Adding the
service does not grant access to another user's mail.

The configured timeout bounds inference latency. SDK requests receive an abort
signal. Native Workers AI has no cancellation option here: the caller times out,
but an already-started native inference may continue remotely.

## Email reply and drafting

The composer offers **AI reply** when opened from a message, and **AI draft** for
a new email. Users may provide optional instructions. The dialog sends the
current subject and plain-text draft with the current UI language; AI output is
previewed separately and only enters the editor after **Use this draft** or
**Replace body**. Cancellation leaves the draft intact. Inserting a result
escapes it as text, retains recipients, subject, threading and attachments, and
does not submit or schedule an email. Successful send clears the AI source too.
Replies without RFC Message-ID headers still use their internal message ID.

`POST /api/v1/mailboxes/:mailboxId/ai-reply` accepts `{ sourceMessageId?, subject,
instructions?, draftBody?, language }` and returns `{ data: { text } }`.
It requires `message.read`, `message.send`, mailbox read/send access and an
`Idempotency-Key`. The messages use case checks mailbox access before reading
the source or replaying a result. Source content is loaded server-side within the
requested mailbox, excludes caller-deleted messages, and cannot be supplied by
the client. Global administration grants no private-mail bypass.

Instructions are limited to 4,000 characters, draft/output text to 16,000, and
the source body to 24,000. HTML-only mail is stripped with the existing HTML
sanitizer; no remote images or attachments are fetched or sent to the model.
The system prompt treats original email as untrusted quoted data and asks for
plain text without invented facts, subject headers or signatures. Provider
endpoints, credentials and models always come from administrator configuration.

Paid inference reserves the existing D1 idempotency key before contacting the
backend. Concurrent requests with the same key return
`409 IDEMPOTENCY_REQUEST_PENDING`; completed success or sanitized failure is
replayed without another inference. Hashes include mailbox and request body.
Settlement and audit are one D1 batch. A crash or settlement failure retains
the reservation rather than issuing an automatic repeat. The browser and SDK
both disable automatic inference retries; a manual Generate is a new request.
Closing the dialog aborts the browser wait, but a started server/model operation
may finish and remain chargeable within the configured timeout boundary.

Generated text is private response data in the idempotency record, retained by
the existing 24-hour default cleanup policy. Every replay rechecks authorization.
Audit records contain outcome, mailbox ID, protocol and usage, or a stable error
code; they contain no original body, instructions or generated text. Responses
use `Cache-Control: no-store`.

## Deployment and verification

Migration `0034_ai_configuration.sql` creates and seeds the disabled configuration;
its paired verification file checks the row. The contract schema version advances
to `0034`. Apply migrations through the existing deployment workflow before running
the new Worker. Staging, production and preview example configurations include
`"ai": { "binding": "AI" }`; development explicitly sets `remote: true` because
native inference runs remotely. Test and legacy local fixture configurations omit
AI so the automated suite does not invoke or authenticate against remote AI.
An installation that only uses an SDK backend may omit the optional AI binding.

Tests exercise real local D1 encryption, credential preservation/removal, permissions,
concurrent saves, idempotency and audit rollback. Adapter tests use the actual SDKs
with synthetic HTTP responses, and a synthetic native binding. UI tests exercise
saving, read-only controls, credential clearing and conflict behavior. These are
local and synthetic checks; real account/model inference requires separate acceptance.

Local verification on 2026-10-12: `pnpm verify` passed all 14 scaffold checks,
binding type generation check, ESLint, TypeScript, web/Worker builds, 1,305 unit
and frontend tests, 971 Worker tests and 23 migration tests (2,299 total).
Worker HTTP tests exercise the actual SDK with synthetic HTTP responses and real
local D1 authorization, replay, concurrency, failure/audit rollback and output
limits. Composer tests cover preview, explicit insertion, cancellation, late
responses, no automatic retry, preserved threading and escaped output.
Desktop and 390-pixel mobile browser checks use synthetic local APIs: the
independent Admin page and real Tiptap reply insertion were observed. This is
browser UI evidence only; those checks do not prove real model inference or
provider acceptance. The final section-title copy
change was followed by the five configuration panel tests.

Staging publication on 2026-10-12 deployed revision `5f85a35` as version
`e4981bdf-2992-4794-8e9d-783263925e3d`. The release gate passed 2,300 tests
and all 34 remote schema companions. Raw SQL migration tests now cover tracking
and recovery after partial application; the original migration fixture had hidden
a missing registration statement. Live metadata confirms the native AI binding,
and the configuration is disabled with no API key. Health/readiness and protected
AI-route checks passed. See [staging QA](../qa/ai-staging-2026-10-12.md).
Real inference and generated-mail delivery remain unverified.

References: [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/),
[Workers AI JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/),
[Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
[OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create).
