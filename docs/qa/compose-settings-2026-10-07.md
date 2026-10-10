# Compose right dock and configured attachment limits — 2026-10-07

Environment: https://staging.unimailbox.tech. Final Worker version: `bbfc4198-549d-4d6a-844f-c30085555d92`. Branch: `cap/CAP-065-mailbox-sharing-ui`. Existing dirty work preserved; no commit/push or production operation.

## Delivered behavior

- Zoom out docks Compose at the bottom-right on desktop and mobile. Width uses the available containing viewport, so background scrollbars cannot clip the mobile window. Zoom in preserves the mounted draft.
- The shared compose/signature editor reads a narrow authenticated `/api/v1/editor-assets/policy` projection. File help, browser validation and Worker upload validation use the stored `maxAttachmentBytes`. Images use the smaller of that setting and 5 MiB. Display uses the same MB/KB convention as the general settings form.
- Uploads are disabled while limits are unavailable, with a retry action. Before sending bytes, the editor refreshes the policy; the Worker independently rechecks current settings. Saving general settings invalidates the editor policy query.
- Migration 0030 raises the metadata storage ceiling to the existing system-settings maximum of 100 MB. It preserves capability ids/hashes, R2 keys, usages, indexes and pending quota trigger. It does not raise the configured limit. Staging finishes with its original 67,108,864-byte (64 MB) setting and 5 MiB image limit. The >10 MB hosted-attachment mail policy is unchanged.

## Local checks

| Check | Result | Evidence under `.tmp/compose-settings-20261007/` |
|---|---|---|
| Unit/web/contracts | 93 files, 1,273 tests passed | `unit-all.log` |
| Worker | 53 files, 882 tests passed | `worker-all-retry.log` |
| Migration/test-kit Worker | 19 passed, including populated 0029 → 0030 upgrade | `worker-all-retry.log`, `migration-test.log` |
| Focused editor/window/settings | 27 passed | `web-test.log` |
| Types, source lint/format, doctor | passed; doctor 14/14 | `typecheck-final.log`, `lint-all.log`, `format-all.log`, `css-format-final.log`, `doctor.log` |
| Final Vite build and Worker dry-run | passed | `build-web-final.log`, `dryrun-prebuilt.log` |
| Final deployment | successful | `deploy-final.log` |

The first complete Worker run had one 10-second `beforeEach` initialization timeout in the existing outbound-smoke test (881 passed). Its isolated retry passed all 12 tests; the complete retry then passed 882/882 without changing the test or its timeout. The first custom-limit fixture also needed its required settings timestamps added before passing.

`pnpm build` compiled contracts, web and the Worker bundle, but Wrangler 4.121.0 remained alive after printing `--dry-run: exiting now.`. Disabling metrics reproduced it. Only those two task-owned dry-run processes were terminated. The produced Worker bundle was subsequently validated with `wrangler deploy ... --dry-run --no-bundle` (exit 0); the final web build and real staging deployments also exited 0. Build scripts were not changed to hide this CLI limitation.

## Staging acceptance

- Before migration: exported D1 backup `staging-before.sql` with restrictive permissions; verified remote schema 0029. The staging config intentionally uses the repository's pending-only migration workflow rather than Wrangler's default migrations directory. Executed only 0030 after checking its tracking row was absent.
- After migration: all columns of all 18 editor assets and all 16 usages match the pre-migration snapshot exactly; `PRAGMA foreign_key_check` is empty, and 0030 is tracked. Private snapshots stay gitignored.
- Actual admin UI saved 64 → 63 MB. The mounted editor displayed `files up to 63 MB`. Saving 64 MB again refreshed the same editor to `files up to 64 MB`, retaining its draft. Original settings were independently confirmed/restored; no persistent setting change remains.
- Actual browser selected a sparse 65 MB file while configured to 64 MB: rejected with `maximum 64 MB per file` before attachment bytes were sent. Worker independently rejects declared size 67,108,865 with HTTP 413 / `BODY_TOO_LARGE`.
- Authenticated member can read only the two upload limit fields; the administrative settings endpoint remains HTTP 403 for that member. Anonymous policy request is HTTP 401. These were repeated against the final deployment.
- An existing published `compose-tiny.txt` download still returns the original full bytes and attachment disposition after migration. No new email delivery was necessary for this layout/configuration follow-up; the preceding real-mail acceptance remains in `compose-window-2026-10-07.md`.
- Final desktop 1440 × 900: dialog x=833, width=576, right=1409 (16 px from the 1425 px layout viewport), bottom=900. Mobile 390 × 844: x=8, width=359, right=367 (8 px from the 375 px layout viewport), bottom=844. Neither has horizontal document overflow or a clipped left edge. The unsent subject survives resizing. Fullscreen restores to x=0/y=0 with viewport height.

Safe API evidence: `live-policy-evidence.json`, `live-policy-final.log`. Browser evidence: `browser-desktop-63.json`, `browser-desktop-final.json`, `browser-mobile-final.json`, `browser-mobile-full-final.json`, `browser-overlimit.json`, `desktop-right-final.png`, `mobile-right-final.png`. The initial mobile screenshot exposed the scrollbar-width clipping; it was corrected and the final screenshots/bounds above were taken from the later deployment.

No DNS, secrets, bucket or manual configuration is required. QA API sessions were logged out. The owned browser draft/login and saved authentication profile are removed after verification; other browser sessions are untouched.
