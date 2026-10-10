# Bounded Contexts

See `../E-proposed-domain-model.md §E.1–E.2` for the full context map.

## Summary

```text
┌─────────────────┐
│   Identity      │   User, Session
└────────┬────────┘
         │ owner-of
         ▼
┌─────────────────┐         ┌─────────────────┐
│   Tenancy       │◀────────│   Onboarding    │
│  Mailbox,       │ claims  │  Installation,  │
│  ManagedDomain  │         │  RegistrationKey│
└────────┬────────┘         └─────────────────┘
         │
         │ routes-to
         ▼
┌─────────────────┐   composes    ┌─────────────────┐
│ Inbound Mail    │──────────────▶│   Messages      │
│  (process)      │               │  Message, etc.  │
└─────────────────┘               └────────┬────────┘
                                           │
                                           │ composed-into
                                           ▼
                                  ┌─────────────────┐
                                  │ Outbound Mail   │
                                  │  OutboundJob    │
                                  └─────────────────┘
                                           │
                                           │ audits
                                           ▼
                                  ┌─────────────────┐
                                  │ Administration  │
                                  │  Settings, etc. │
                                  └─────────────────┘
```

## Context ownership rules

| Concept | Owning context |
|---|---|
| User identity | Identity |
| Mailbox identity | Tenancy |
| Message canonical content | Messages |
| Inbound transport | Inbound Mail |
| Outbound transport | Outbound Mail |
| Provider connection | Outbound Mail |
| Provider webhook processing | Outbound Mail |
| Installation state | Onboarding |
| Roles + permissions | Administration |
| Audit log | Administration |
| Settings | Administration |

## Context integration patterns

| From → To | Pattern |
|---|---|
| Onboarding → Identity | First administrator created via setup wizard |
| Onboarding → Tenancy | First managed domain claimed via setup wizard |
| Tenancy → Inbound Mail | `mailboxes.findByAddress` lookup |
| Tenancy → Outbound Mail | `mailboxes.assertCan` authorization |
| Inbound Mail → Messages | Insert Message + MailboxMessage |
| Outbound Mail → Messages | Insert Message + MailboxMessage + transition status |
| Outbound Mail → Administration | Audit event emission |
| All → Administration | Audit event emission |

There is **no** shared "kernel" sub-domain. Each context owns its types. The only shared types are in `packages/contracts/`.