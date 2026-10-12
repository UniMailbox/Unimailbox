# Reference Implementation Rules

External repositories may demonstrate viable integration patterns. They do not override
Unimailbox business rules, architecture, security, or delivery gates.

## Required provenance

When a capability uses external code or patterns, its `task.md` records:

- repository URL, pinned commit, license, and exact files inspected;
- the behavior being adopted;
- the Unimailbox-specific adaptation;
- behavior explicitly rejected and why;
- copied or closely adapted code that needs attribution or license notices.

“Latest” is not a reproducible reference. Pin a commit before implementation.

## Decision order

When sources disagree, use this order:

1. Current user instructions and accepted Unimailbox decisions (newer decisions supersede older proposals).
2. Current business rules, security, authorization, data ownership, idempotency, and audit constraints.
3. The current capability contract.
4. The external implementation pattern.

An upstream choice that weakens tenant isolation, makes durable work best-effort, moves
authorization truth into object storage, or bypasses the provider registry must be rejected or
covered by a new ADR before use.

## Review obligation

Reviewers compare the implementation with both the pinned source and the Unimailbox adaptation
decision. They must check that:

- copied structure did not import upstream trust-boundary assumptions;
- the reference did not become a second source of API or domain types;
- delivery/configuration pieces used by the pattern are present, not only application code;
- licensing obligations are preserved;
- tests prove Unimailbox behavior, including denied and failure paths.

The canonical Agentic Inbox adaptation decisions live in
`docs/rebuild/11-agentic-inbox-adaptation.md`.

Current UI provenance is in `docs/rebuild/15-shadcn-admin-ui-redesign.md`; editor
and R2 storage design is in `docs/rebuild/16-email-editor-storage.md`.
The original shadcn-admin-kit proposal is superseded.
