# CAP-053 — Message detail attachment download controls

## Outcome

Implemented and independently reviewed on local `master`. Message detail now exposes a small
client-side list of the consumed attachment metadata returned by CAP-052 and a control for the
existing CAP-051 binary download route.

## Behavior

- One row is rendered per descriptor in the API-provided order.
- Rows display filename, content type, human-readable size, disposition, and an accessible
  download link.
- Links are same-origin relative paths with `encodeURIComponent` applied to mailbox and attachment
  IDs; the browser requests bytes only after user activation.
- Empty or legacy details without `attachments` omit the list without affecting the detail page.
- Metadata is rendered as text; upload IDs, storage keys, bytes, credentials, and idempotency values
  are not placed in the DOM, URL, or logs.
- HTML body rendering and inline CID rewriting remain out of scope.

## Verification

| Check | Result |
|---|---:|
| CAP-053 focused Web tests | 18/18 |
| Full unit/Web tests | 981/981 |
| Full Worker tests | 870/870 |
| Scaffold doctor | 14/14 |
| Lint/typecheck/format/build/diff check | pass |
| Grok architecture/security review | ACCEPT |

The test runner reported loading `apps/worker/.dev.vars`; no values were inspected, printed,
copied, or changed. No push, deploy, R2 change, extra KV namespace, or production operation was
performed.

## Deferred

Inline image/CID rendering and any HTML-body attachment preview are separate future work. Durable
R2 retention and CAP-054 preview/provider verification remain deferred.
