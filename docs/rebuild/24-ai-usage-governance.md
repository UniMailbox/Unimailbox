# AI usage governance

CAP-072 adds AI-owned policy and durable attempt accounting to the existing
[AI foundation](18-ai-service-foundation.md). Migration 0042 is additive. This
is local implementation; installation deployment and provider verification are
separate acceptance. General release compatibility and disaster recovery remain
in [INV-004](../../work/investigations/INV-004-ai-governance-release-recovery-2026-10-16.md).

## Admission and attribution

Production composition always injects governance into the AI service. Mailbox
read/send authorization still runs in the messages use case before both replay
and generation. HTTP and MCP requests enter the same service with the verified
user, operation key, input hash and request ID. No browser-supplied user identity
is trusted. The pure service's optional collaborator is for isolated adapter
and orchestration tests; production does not expose an ungoverned endpoint.

A single D1 INSERT SELECT admits the attempt only if the active user, policy
revision, AI configuration revision, circuit breaker, installation concurrency,
user concurrency and all enforced budgets permit it. Admission and its guarded
audit share a batch. No separate read-then-write counters can admit both racers
against the last token budget. D1 remains authority across Worker isolates.

Installation and user monthly/daily budgets apply together in enforcement mode.
UTC calendar periods are based on submission time. Overrides replace the default
user limit; they cannot bypass the installation pool. Zero is a real prohibition.
An in-flight operation references an immutable normalized policy version and
retains its model/configuration identity. No governance JSON-in-text columns are used.
Policy changes never rewrite historical charges or terminate submitted work.

Default migration values are 1,000,000 installation tokens/month, 250,000/day,
100,000 default user tokens/month, 25,000/day, concurrency 4 installation/1 user,
64 KiB final request input and 32,768 input token reservation. **Mode defaults to
observe**: token quotas are not enforced, but byte and concurrency caps are.
Operators must review these defaults; they are not measured usage requirements.
Paused mode denies new inference. Existing idempotency replays remain readable
under their existing mailbox authorization and response-retention policy.

## Token guarantees and model verification

The reservation uses UTF-8 bytes of the final normalized request (including
system and schema) plus a verified protocol overhead and maximum output tokens.
It deliberately over-reserves plain byte-tokenized text rather than using
characters/4. Missing evidence uses an explicitly unverified observation budget.
The byte cap is always checked before provider I/O; enforcement also checks the
input reservation and context window minus the maximum output allowance.

Enforcement requires an operator-provided verification reference bound to the
exact AI configuration revision, context window and protocol overhead. The
operator must establish that the provider's tokenizer needs no more than one
token per serialized UTF-8 byte plus this overhead, and that its output cap is
honored, including reasoning tokens. **No provider/model is automatically
certified by this implementation.** A protocol-compatible URL does not prove
these properties. A changed AI configuration invalidates the profile; strict
admission refuses it until verified again. The supplied profile records external
acceptance evidence; entering an arbitrary reference does not create that proof.

The local admission invariant is hard for the recorded reservation units. An
actual-provider token ceiling additionally depends on the validated upper bound
and output cap. Do not claim production token guarantees from synthetic tests.
Any reported usage exceeding its reservation is retained as fact and opens a
circuit breaker. New admission stops across users. A pricing edit cannot clear
it; a new verified model reference in enforcement mode is required. Unknown
provider usage cannot be reported as zero.

## Attempts, usage and uncertain outcomes

`ai_attempts` has submitted, outcome_unknown and completed states. The durable
submitted row precedes the first provider call. Adapter usage is observed and
persisted before final-answer stripping, refusal checks or JSON validation.
Anthropic cache-read/cache-creation input is included once in total input;
OpenAI cached/reasoning details are retained without adding them twice to the
provider's input/output totals. Metadata contains numbers and provider IDs,
never prompts, mail bodies, credentials or generated text.

A valid content result and a known usage result are separate facts. A refusal,
truncation or invalid JSON may still have a reported charge. A terminal response
with incomplete usage is charged conservatively at least the whole reservation;
its remote concurrency slot is released. A timeout, connection loss or lost
local process retains both quota and uncertain in-flight capacity. A lease or
calendar reset does not imply upstream work ended.

Explicit SDK request-rejection responses (400/401/402/403/404/413/422/429)
record terminal evidence and release remote concurrency. Missing provider usage
still charges the reservation conservatively; an HTTP rejection does not invent
zero usage. Transport errors, 408, 409 and 5xx remain unknown. An absent native
Workers AI binding is known to precede provider work and settles with zero tokens.

The existing five-minute maintenance tick classifies at most 100 submitted
attempts older than three minutes as unknown (longer than the configurable
120-second service timeout). It never resubmits inference or releases capacity.
Persisted terminal usage observations can be settled conservatively by the same
maintenance task after a crash, without repeating generation. A late adapter
continuation can record/settle once while its Worker survives;
correctness does not rely on that continuation or waitUntil surviving disconnect.
There is no generic provider query/cancellation implementation in this slice.

The user can stop waiting; that does not establish stopped inference/billing.
The dialog retains the hashed input fingerprint and operation key in its page
query cache, scoped to user/mailbox, so re-opening the same request on that page
reuses its key. No prompt or browser persistent storage is used. An explicit new-request action starts another paid
operation. A hard reload, separate tab or device does not retain this in-memory key;
server-side attempt holds and shared concurrency remain authoritative.

AI attempt identities and legacy operation tombstones are independent of the
24-hour response cache. Expired response cleanup cannot submit a new inference
under a previously recorded key. Migration 0042 copies retained legacy AI keys;
records already deleted before this migration cannot be reconstructed. Attempts
and tombstones are currently retained without automatic deletion. Queries use
period/user/active indexes and return only the latest 20 details. A future
retention migration must preserve deduplication and unresolved holds.

Administrators with settings.manage and analytics.read can record independently
confirmed terminal evidence. This is an explicit human assertion, not a verified
provider lookup. Token counts may be left unknown to retain a conservative
charge. Reconciliation, its replay and audit commit atomically, cannot settle
an already completed attempt again, and never resubmits inference. Automatic
completion cannot overwrite an existing manual terminal decision.

## APIs and UI

Existing strict configuration and generated-reply response bodies are unchanged.
New routes are separate:

| Route | Permission / purpose |
| --- | --- |
| GET /auth/me/ai-usage | Authenticated caller's own summary and latest attempts; ignores userId input |
| GET /admin/ai-governance | settings.read; policy/revision/breaker, settings.manage projection |
| PUT /admin/ai-governance | settings.manage, Idempotency-Key and numeric If-Match; atomic CAS/replay/audit |
| GET /admin/ai-governance/usage | analytics.read; installation summary or validated user UUID filter |
| POST /admin/ai-governance/attempts/:id/reconcile | settings.manage + analytics.read, Idempotency-Key, explicit confirmed terminal evidence |

All routes use the existing /api/v1 prefix and no-store responses. Own-user
responses contain no other users' history, profile references or policy overrides.
Audit statements use an injected shared writer with a guarded attempt transition
marker; AI persistence does not depend on admin's private repository.

Administration → AI services includes a policy editor, quota bars, current
period totals, in-flight/unknown counts and recent attempts. The AI draft/reply
dialog shows personal usage. Scope caches include the user identity. Loading,
error, refresh, observation, paused, unknown-usage and unpriced states are explicit.
The UI includes English and Chinese text and preserves the shared editor dialog.

Fees are estimates using configured input/output prices per million, currency
and the submission policy snapshot. Pricing applies only to its verified AI
configuration revision. Unknown prices or incomplete usage show no cost estimate;
zero prices correctly yield zero. Cached input is included at the configured
input price, without provider-specific discounts; these figures are not invoices
and do not include other applications using the same provider credentials.

## Validation and rollout boundaries

Regression coverage includes D1 admission competition, overrides/zero limits,
unknown capacity across month changes, expired operation identity, stale model
profiles, missing usage, overshoot breaker, audit failures, late completion,
terminal reconciliation, privacy and route permissions, policy replay/CAS,
legacy-key migration, UI states and policy editing. Full local gate evidence is
recorded in the [handoff](../../work/handoffs/ai-governance-2026-10-16.md).

Apply the backed-up additive 0042 migration before matching code through the
normal authorized deployment flow. Preserve keys and installation resources.
Start in observe mode; record external model evidence and review budgets before
enforcement. A prior Worker may read the additive schema but does not enforce
quotas: disable paid AI admission before code rollback. The general recovery
and compatibility work in INV-004 has not been implemented by this slice.
