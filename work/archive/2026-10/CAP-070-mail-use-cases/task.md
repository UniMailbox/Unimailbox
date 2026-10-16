# CAP-070 — Shared mail mutation use cases

Scope: extract create/read/update draft, draft submission, compose submission and
per-user read/star/delete orchestration from routes. HTTP and MCP draft/send
mutations call the same public module operations. Preserve existing contracts,
request hashes, authorization, conditional batch markers, audit and outbox recovery.
No UI, schema, provider, deployment or unrelated workspace changes.

Rules: R-AUTHZ-003/004, R-API-004, R-CONCURRENCY-001, R-MESSAGE-005,
R-OUTBOUND-005/006, R-AUDIT-001, R-ATTACHMENT-006.

Acceptance: existing route/compose/attachment/scheduled/MCP regression coverage;
direct use-case allowed/denied/replay/conflict, stale-draft and atomic rollback
coverage; canonical gate with unrelated personal MCP UI edit preserved and
identified separately. Self-review only. Main session owns all edits.

Outcome: implemented locally on 2026-10-16; final isolated canonical gate passed
2,526 tests. Self-review only; no live deployment/provider acceptance. Evidence:
`work/handoffs/mail-use-cases-2026-10-16.md`.
