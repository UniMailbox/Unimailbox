# State Machines

See `../E-proposed-domain-model.md §E.4` for full diagrams and invariants.

## Summary

### Message status

```text
draft → queued → sending → sent → delivered (terminal happy)
                       ↘
                        delayed → (retry) → sending
                       ↘
                        bounced (terminal)
                       ↘
                        complained (terminal)
                       ↘
                        failed (terminal)

received (inbound only)
```

Webhook status rank (higher wins on tie):

| Status | Rank |
|---|---:|
| draft | 0 |
| queued | 10 |
| sending | 20 |
| sent | 30 |
| delayed | 40 |
| delivered | 50 |
| bounced | 60 |
| failed | 60 |
| complained | 70 |
| received | 100 |

### Outbound job status

```text
pending → enqueued → processing → succeeded (terminal)
                              ↘
                               failed (terminal)
                              ↘
                               (lock expired) → pending
```

### User status

```text
active ↔ suspended (admin)
active → deleted (user action, irreversible)
```

### Mailbox status

```text
active → disabled (admin)
disabled → active (admin)
active → deleted (owner)
```

### Installation status

```text
pending → in_progress → complete
```

Strictly ordered steps:

```text
claim → preflight → administrator → cloudflare → domain
     → inbound_smoke_test → brevo → outbound_smoke_test → complete
```

### Webhook delivery processing status

```text
processing → succeeded (terminal)
processing → ignored (terminal)
processing → failed → (lock expired) → processing
```

## State transition matrix

| Current | Action | Actor | Condition | Next | Side effect |
|---|---|---|---|---|---|
| (none) | claim | anonymous | INSTALLATION_TOKEN matches | (claim step done) | KV setup session |
| claim | advance to preflight | anonymous (setup session) | none | preflight | audit |
| preflight | verify | (system) | all bindings + schema OK | preflight done | audit |
| preflight | verify | (system) | any binding missing | stays at preflight | error response |
| (any setup step) | advance to next | admin (setup session) | previous step done | next step | audit |
| active | suspend | admin | permission `user.manage` | suspended | KV session purge |
| suspended | restore | admin | permission `user.manage` | active | (none) |
| active | delete | user (self) or admin | self-delete or permission | deleted | KV session purge; cascade |
| active | disable | admin (mailbox owner) | permission `mailbox.manage` | disabled | (none) |
| disabled | enable | admin (mailbox owner) | permission `mailbox.manage` | active | (none) |
| active | delete | mailbox owner | permission via ownership | deleted | cascade messages |
| draft | send | user (draft creator) | permission `message.send` + mailbox `send` | queued/sent | outbound_jobs row + mailbox_messages row |
| queued | dispatch | worker (queue consumer) | claim acquired | processing | (none) |
| sending | provider success | worker | provider returned message ID | sent | provider_message_state link |
| sending | provider retryable error | worker | attempts < max | delayed | (none) |
| sending | provider terminal error | worker | (any time) | failed | error_message set |
| sent | webhook delivered | worker (webhook handler) | rank ≥ stored rank | delivered | audit |
| queued/sending | max attempts | worker | attempts ≥ max | failed | audit |
| (any inbound) | receive | worker (email handler) | recipient + pass blocklist | received | audit + R2 upload |
| (none) | blocked | worker (email handler) | blocklist hit | (no message) | message.setReject upstream |
| (none) | unknown recipient | worker | policy=reject | (no message) | message.setReject upstream |
| (none) | unknown recipient | worker | policy=store | received (no mailbox_messages) | (none) |
| pending | dispatch | scheduler | cron tick + due | enqueued | (none) |
| enqueued | claim | worker (queue consumer) | claim succeeded | processing | (none) |
| processing | succeed | worker | provider OK | succeeded | audit |
| processing | retry | worker | retryable error, attempts < max | enqueued | (none) |
| processing | fail | worker | terminal error OR max attempts | failed | audit |
| succeeded | (none) | (terminal) | — | succeeded | — |
| failed | (none) | (terminal) | — | failed | — |