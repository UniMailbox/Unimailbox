# Measured query and cache optimization

CAP-071 is a local implementation on 2026-10-16. It changes neither the single
Worker architecture nor MCP authentication, and introduces no polling or Durable
Object. Live installation latency and migration duration remain unmeasured.

## Baseline and decisions

A synthetic local D1 mailbox contains 1,000 messages; the selected thread has
10 members. Twenty-five sequential samples per candidate recorded query count,
D1 `rows_read`, D1 duration and local call P95. All P95 values were 1 ms at the
local clock's resolution; this is insufficient evidence of a latency win and
must not be presented as production P95. Mean D1 durations ranged from 0 to
0.2 ms and likewise have limited resolution. The reliable difference is scans.

| Measured operation | Queries | Rows read per sample | Plan |
| --- | --- | --- | --- |
| Original thread member read | 1 | 2,010 | Mailbox lookup, each message by primary key, temporary ordering |
| Global expression-index candidate | 1 | 20 | Root expression index, then mailbox association |
| Selected mailbox/root candidate | 1 | 30 | Composite mailbox/root index, then message/state lookups |
| Original authentication session + user | 2 | 2 | Two primary-key lookups |
| Joined authentication projection | 1 | 2 | Session and user primary-key join |

A global root index can scan other mailboxes that share a common thread header.
The selected composite index filters by both mailbox and root. A separate
regression fixture adds 1,000 foreign-mailbox messages with the same root and
asserts the target query reads at most 40 rows and returns its ten members only.
The result window remains the newest 50 members, displayed oldest first; a very
large thread can still require sorting its own mailbox's matching members.
The anchor and recipient reads remain separate: the complete nonempty thread
operation still uses three queries.

`/auth/me` now reuses the middleware's safe projection in the same request.
Identity reads shrink from session + user + repeated user to one joined query;
installation and administrative-permission reads are separate. D1 still verifies
session expiry/revocation, exact owner and active account on every request. The
projection contains user/session IDs, email, display name and forced-password-
change state, without password/refresh-token material. There is no shared or
cross-request authorization cache. Mailbox authorization remains in use cases.

## Thread-root persistence

Migration 0041 adds `mailbox_messages.thread_root` and
`mailbox_messages_mailbox_thread_idx(mailbox_id, thread_root)`. It backfills the
existing read-time precedence without rewriting `messages.thread_id`:
explicit thread ID; first valid bracketed References token; In-Reply-To; own
Message-ID; otherwise null. Malformed References retain their old fallback.
Null-root mail remains a singleton; distinct headerless messages never merge.

Triggers derive roots when an association is inserted or rebound and when any
threading header changes. Changes and derived roots commit/roll back together,
including message associations created by inbound, draft, compose and scheduled
flows. Updates to subject, body, send state or user flags do not recompute roots.
All association writes are owned by messages. Migration verification checks the
column/index/triggers, agreement with source headers and migration registration.

The migration touches every existing association once and adds index/trigger
write cost. Back up and measure the selected installation before applying 0041;
no remote migration was run here. Deploy matching source only after 0041. Code
rollback may retain this additive schema: the previous reader computes the same
roots and tolerates the extra column/index/triggers. Do not drop the new substrate
while the new reader is serving traffic.

## Frontend freshness and write coherence

| Data | Freshness window |
| --- | --- |
| Mailbox list | 60 seconds |
| Folder pages | 10 seconds |
| Message detail | 30 seconds |
| Thread | 10 seconds |
| Editable draft | 0: always revalidate server version |
| Membership list | 0: always revalidate grants |

Keys remain scoped by user, mailbox, resource and folder. An unexpired remount
reuses data; expiry, explicit invalidation and existing manual refresh fetch it
again. New external mail/provider changes become visible on the next stale
refetch; no realtime delivery is implied. These are UI snapshots, never server
authorization decisions.

Confirmed read/star/delete operations update all cached folder, detail and
thread representations of that message in the same user's mailbox. Delete drops
the deleted anchor/detail and removes it from sibling threads; star retains its
existing optimistic/rollback behavior. In-flight cached sibling reads are
cancelled before star/delete; a not-yet-loaded query is not stranded. Compose
continues to invalidate only its mailbox's message family. Draft saves keep the
server concurrency token and refresh their own draft entry. Other accounts and
mailboxes are unaffected.

Validation and publication status are owned by the current ledger and
[handoff](../../work/handoffs/query-cache-2026-10-16.md).
