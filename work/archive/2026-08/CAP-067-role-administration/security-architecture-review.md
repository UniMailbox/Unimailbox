# CAP-067 security / architecture review note

The requested read-only architecture/security subagent review was started twice. Both subagents
were stopped after extended execution without returning a report; no subagent finding is being
represented as a conclusion here.

The main session performed the direct code audit required for this slice. The audited boundary is:

- `requirePermission('role.read')` / `requirePermission('role.manage')` backed by `user_roles`;
- closed `PermissionKey` and exact 21-entry permission catalog contracts;
- parameterized role and relation SQL;
- system-role protection and `user_roles`-aware delete guard;
- one D1 batch for idempotency record, role/relation write, and audit event;
- request-hash replay and stable conflict behavior;
- safe role projections without user assignments or credentials.

The focused Worker tests and full Worker pool exercised these paths against real D1/workerd:
focused role routes 7/7 and full Worker 904/904. No unresolved BLOCKER, HIGH, or MEDIUM issue was
identified by the direct audit. Preview verification and deployment remain out of scope.
