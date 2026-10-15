# Unimailbox design and delivery documentation

This repository contains the Unimailbox application. Earlier analysis and recovery
plans are retained as design history; use current source and the capability ledger
for implementation status.

## Start here

- [Product overview](00-executive-summary.md) and [repository map](01-current-system/repository-map.md).
- [Current state](capability-ledger.md#current-state): implemented behavior,
  dated staging evidence and remaining acceptance gaps.
- [Execution plan](execution-plan.md): current priorities, followed by the
  historical August recovery plan.
- [Implementation log](implementation-log.md): dated changes, not a current task queue.
- [Agent deployment guide](../operations/agent-deploy.md): prerequisites, installation,
  optional settings and real mail acceptance.
- [Deployment runbook](../operations/deploy.md): environment configuration,
  migrations, secrets, publishing and recovery.
- [Acceptance catalog](../qa/acceptance-test-cases.md) and
  [execution CSV](../qa/acceptance-execution.csv): the comprehensive test plan.
  Dated focused records under `docs/qa/` provide observed acceptance separately.
- [Repository hygiene](../operations/repository-hygiene.md): public documentation,
  commit preparation and sensitive-information checks.

## Current design decisions

| Topic | Owning document |
| --- | --- |
| Business constraints and terminology | [Business rules](02-business-discovery/business-rules.md), [glossary](02-business-discovery/business-glossary.md) |
| Modules and integration boundaries | [Module boundaries](05-target-architecture/module-boundaries.md), [API conventions](05-target-architecture/api-design.md) |
| Self-hosted identity and integration direction | [Integration decisions](12-mail-system-implementation-plan.md) |
| Current UI: satnaing/shadcn-admin | [UI adoption](15-shadcn-admin-ui-redesign.md) and source/license manifests |
| Rich editor, images and R2 attachments | [Editor storage](16-email-editor-storage.md) |
| Personal settings and bilingual errors | [Settings and localization](17-personal-settings-localization.md) |
| D1/R2/Queue; conditions for considering a DO | [Storage decision](14-durable-object-mailbox-adr.md) |
| Other accepted decisions | [ADRs](09-decisions/) |

Current user decisions and their accepted implementation updates supersede earlier
design proposals. If source and a current document disagree, investigate and
correct the owning document; do not use an obsolete plan to restore old behavior.
An implemented feature is not automatically verified in every environment.

## Historical material

`01-current-system/dependency-map.md`, `01-current-system/module-map.md`, `03-domain-design/`,
`04-legacy-review/`, `06-business-loops/`, `07-migration/`, `08-roadmap/`,
`10-open-questions.md` and the `A`–`J` deliverables describe the original analysis,
target design and phased plan. Their phase/status statements are dated provenance;
use the ledger's Current state for today's work.

[Agentic Inbox adaptation](11-agentic-inbox-adaptation.md) records pinned patterns,
not a replacement for Unimailbox's authentication or mailbox ownership.
[shadcn-admin-kit adoption](13-shadcn-admin-kit-adoption.md) is superseded by
the user-selected satnaing/shadcn-admin reference in document 15.

Legacy data import and production cutover remain separate acceptance work. The
old and rebuilt schema histories are incompatible; never apply the rebuilt
migrations directly to a legacy installation.

Agent conventions live in [CLAUDE.md](../../CLAUDE.md) and `.claude/`.

- [19. Scoped MCP service](19-mcp-service.md) — administrator toggle, scoped agent credentials and independent send authorization.
- [18. AI service foundation](18-ai-service-foundation.md) — selectable protocols, administrator configuration and unified inference seam.
