# Staging browser KV reduction

Completed 2026-10-14 on `codex/kv-request-reduction-20261014`.
Application `72d86f6`, fixture/release source `79ceaf2`; Worker
`1e0bdd33-1a59-4698-834b-10946a7bc7eb` at `https://staging.unimailbox.tech`.
Schema remains 0036; no migrations, resource/key or production changes.

- Recent browser identity results are reused for 60 seconds. A fresh guarded
  inbox has zero additional session reads, previously two. Server D1 session,
  account/permission checks and fresh admin-entry checks remain authoritative.
- Unauthenticated/repeated logout clears cookies without KV delete. Valid
  logout still revokes the session and deletes its token exactly once.
- Canonical gate: 2,397 tests, doctor 14/14, bindings, lint, TypeScript/builds;
  all 36 remote companions, release smoke and operations health passed.
- Live login/identity/logout, repeated/invalid logout and denial of revoked
  access/refresh credentials passed. Diagnostic login was logged out; no mail
  content read, mail sent or MCP configuration changed. Self-review only.
- Pre-change GraphQL showed 67 reads/zero deletes during the preceding 24 hours;
  it did not show an ongoing idle-delete recurrence. The operator's exact alert
  window/threshold, native-browser request capture and a full post-release
  metric day remain separate. Refresh open tabs to load the new frontend.

Full counts, release identities, local versus runtime boundaries and references:
`docs/qa/kv-request-reduction-2026-10-14.md`.
