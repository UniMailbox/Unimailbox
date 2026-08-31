# CAP-067 — Role administration

> Archived capability contract. Implemented locally on 2026-09-01.

## Goal

An authorized administrator can inspect the closed permission catalog and manage custom role
definitions after setup. The seeded `administrator` and `member` roles remain visible and protected
from mutation; assigning roles to users remains a separate user-management capability.

## Delivered scope

- Strict contracts for role projections, the exact closed permission catalog, and create/update /
  delete requests.
- `GET /api/v1/admin/roles` with `role.read` and custom-role mutations with `role.manage`.
- Atomic custom-role creation, full replacement of metadata and permission relations, and deletion
  only when no user is assigned.
- Stable errors for duplicate names, missing roles, protected system roles, unavailable
  permissions, assigned roles, validation, and idempotency conflicts.
- Request-hash checked `Idempotency-Key` on every mutation; business state, audit, and idempotency
  rows share one D1 batch.
- `/admin/roles` list/create/edit/delete UI with server-authoritative authorization, read-only
  system roles, strict response parsing, validation/error/retry/empty states, and confirmation.

## Explicit exclusions

User-role assignment, account lifecycle, system-role editing/deletion, new permission keys, role
policies, signatures, settings, migrations, deployment, provider changes, and automatic reassignment
on delete were not part of this slice.

## Business rules

`role.read` and `role.manage` are checked against `user_roles` on every request. Permission keys are
closed and role responses contain no user assignments or secret material. Role names and
descriptions are normalized by the shared contract. `PATCH` is full replacement. Deletion fails
closed with `ROLE_IN_USE` when `user_roles` references the target.

## Acceptance result

All seven acceptance criteria passed locally: administrator/member authorization, normalized custom
role create, atomic permission replacement, protected/assigned/delete behavior, idempotency replay
and conflict handling, Web states and confirmation, and focused/full quality gates.

## Verification

- Focused contracts/Web/router: 6 files, 446 tests passed.
- Focused role Worker routes: 7 tests passed.
- Full unit: 78 files, 1174 tests passed.
- Full Worker pool: 52 files, 904 tests passed against real D1/workerd.
- `pnpm scaffold doctor` 14/14, lint, typecheck, format, `git diff --check`, and `pnpm build`
  passed. The build retained the existing Vite bundle-size warning only.
- Independent Web/QA review found six MEDIUM findings; all were fixed. The review record is in
  `frontend-qa-review.md`. A separate architecture/security review was requested but returned no
  report before shutdown; the main session's direct audit is recorded in
  `security-architecture-review.md` and found no unresolved BLOCKER/HIGH/MEDIUM issue.
- No preview verification, deployment, push, or provider/token change was performed.
