# Core Value Stream

See `../C-core-business-value-stream.md` for the full value stream. This document is a summary.

## The closed loop

```text
Operator installs deployment
       ↓
First admin is bootstrapped from a single shared installation token
       ↓
Admin claims a domain and an outbound provider
       ↓
Admin issues an invitation key
       ↓
Invited user registers → signs in
       ↓
User creates or is granted a mailbox
       ↓
External sender mails the mailbox → Email Routing delivers the raw MIME
       ↓
Worker parses MIME → stores canonical message + attachments
       ↓
User opens the inbox in the browser → reads the message → marks it read
       ↓
User replies → message goes through outbound queue → provider accepts it
       ↓
Status events update the canonical message
       ↓
User (and operator) can see the message in sent, search it, audit it
```

If any link in this chain breaks, the system has failed at its purpose.

## Completion condition

1. The admin's setup state is `COMPLETE`.
2. An invited user can register and log in without admin intervention.
3. A real external email to the user's mailbox appears in their inbox within 60 seconds.
4. The user can reply to that email and the recipient receives it within 60 seconds.
5. The status of the sent message transitions through `queued → sent → delivered` (or terminal failure).
6. The admin can see the user in the user list, the message in the all-mail search, and the audit trail in the webhook log.

## What is *not* in the value stream

- Telegram forwarding
- AI verification-code extraction
- S3 backend
- ECharts dashboard
- Public admin token
- OAuth (LinuxDo)
- Turnstile
- Signatures
- Per-role quota / ban / domain policy
- Registration keys (acceptable default: admin creates user directly)

These are deferred to later phases. They are valuable, but the loop closes without them.