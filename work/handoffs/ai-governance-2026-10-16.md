# CAP-072 AI governance — 2026-10-16

Local implementation of installation/user token quotas, shared concurrency,
normalized policy history and durable inference attempts. Default observation
mode records token budgets without enforcing token quotas; byte/concurrency
safety caps still apply. Enforced admission requires an
operator-verified input/output bound at the exact AI configuration revision.
Provider completion/billing is distinct from caller cancellation.

New schema: 0042. HTTP/MCP attribution shares the service. Terminal usage is
recorded before content validation. Unknown attempts retain capacity, expired
replay cannot regenerate, and the existing Cron classifies stale attempts or
settles persisted terminal evidence without resubmission. Admin policy/usage,
manual terminal evidence and personal usage are separate authorized routes.
UI includes scope bars, unknown/estimated states and English/Chinese copy.

Source basis: 3c76132; research commit 0986c6b, core commit ab52f6b; implementation and plan are local only. The unrelated
PersonalMcpSettings.tsx edit is excluded from commits and the validation snapshot;
its SHA-1 remains 2a223c708de3ab4024dde65922e15932c9c72f22.

Final isolated `pnpm verify` passed: 2,565 tests (1,431 non-Worker, 1,104
Worker and 30 migration fixtures), doctor 14/14, generated bindings, lint,
TypeScript, web and Worker builds. The unchanged personal MCP file from HEAD
is used only in this owned-source validation snapshot.
No secrets, private mail or remote bindings are copied into that snapshot.
Existing bundle-size/source-map warnings and four local runtime connection-lost
messages remain in successful output; no external-delivery claim follows.
Repository-configured Gitleaks and local documentation link checks accompany
the final staged changes.

Self-review only. No paid/provider calls, browser runtime demonstration,
deployment or installation acceptance. Strict provider bounds remain an external
verification requirement; a typed reference is not proof. Manual reconciliation
records an operator assertion, not a provider lookup. The operation key cache is
page memory only; it does not survive hard reloads/tabs/devices. General release
compatibility and D1/R2/key recovery are still planned separately in INV-004.

Owning design: docs/rebuild/24-ai-usage-governance.md.
