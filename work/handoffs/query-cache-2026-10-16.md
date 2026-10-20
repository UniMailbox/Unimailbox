# CAP-071 — Measured D1 queries and mailbox caches

Earlier work is split into four local behavior commits plus documentation:
`2f8b8ad` inbound recovery, `c99ee92` uncertain outbound reconciliation,
`1d50e47` resource dashboards, `9bb6a3d` shared use cases and `db88efa` documentation.
Each behavior commit passed an isolated staged-tree doctor/typecheck and its
focused tests (56; 52; 6 Worker + 13 Web; 70 respectively), with redacted staged
Gitleaks 8.30.1 scans. No push/deployment. The unrelated personal MCP UI edit
retains SHA-1 `2a223c708de3ab4024dde65922e15932c9c72f22`.

Current work adds one joined, safe session/user identity lookup per request;
`/auth/me` reuses it without loading credential columns again. D1 still enforces
expiry, revocation, owner and account status on the next request. MCP's independent
D1 credential path and mailbox access checks are unchanged.

Schema 0041 materializes the unchanged thread-root policy on mailbox associations,
backfills it, adds the composite mailbox/root index and updates roots through
transactional insert/rebind/header triggers. In the 1,000-mail/10-thread fixture,
member-query reads drop from 2,010 to 30; 25 local P95 samples remain 1 ms and do
not establish a latency win. A foreign mailbox with 1,000 common-root messages
does not inflate the target query beyond 40 rows. An expression-only index was
measured but not selected because it cannot constrain the mailbox at index entry.

Mailbox/folder/detail/thread fresh windows are 60/10/30/10 seconds. Drafts and
membership remain stale immediately. Confirmed read/star/delete update cached
sibling folders, details and threads only for the same user/mailbox; scheduled
send projections are excluded by folder-key validation. Compose invalidation is
still mailbox-scoped. Background-error tests explicitly seed expired parent data.

Validation: existing mailbox UI 170 cases, new cache 6, identity/thread 10,
existing message/auth routes 113, migrations 29; source lint/types passed.
Final isolated `pnpm verify` passed doctor 14/14, generated bindings, lint, types,
builds and 2,543 tests (1,428 non-Worker, 1,086 Worker, 29 migration fixtures).
All 699 checked source paths match the shared tree. Known Vite size/source-map
warnings and four local runtime network-connection-lost messages remain; the gate
exits 0 with no test failures. Main-session self-review only; raw experiments/logs stay in `.tmp/query-cache/`.

Canonical policy, measurements and migration/rollback boundaries:
[query optimization](../../docs/rebuild/23-query-cache-optimization.md).
No real-account access, remote migrations, live browser or provider acceptance.

The selected optimization is also split into local behavior commits:
`1560261` joined authentication; `54fba5d` mailbox thread normalization/index;
`0674829` bounded cache freshness and mutation coherence. Each staged tree also
passed doctor/typecheck and focused tests (7 identity; 3 thread + 29 migration;
176 mailbox Web). No push or deployment.
