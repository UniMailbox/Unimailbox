# 1.0.0 release verification

Date: 2026-10-12. Product version: `APPLICATION_VERSION = 1.0.0`.
Release description and upgrade requirements: [1.0.0 notes](../releases/1.0.0.md).

## Local and staging evidence

- Verified application revision: `25e1059a1d3ad9ffba655a1acd3e28467c6ca118`.
  The final release-note/QA changes after this revision are documentation-only.
- Canonical clean-worktree `pnpm deploy:staging` passed doctor 14/14, binding
  type drift, lint, TypeScript, builds and 2,368 tests: 1,357 non-Worker,
  987 Worker and 24 migration fixtures.
- Staging: https://staging.unimailbox.tech.
- Worker version: `01d1bd24-80b1-473c-be4f-2edc16d4765f`.
- Source digest: `d67c1e787c2fd235ad197427729aaeb3cb878ff5cbfb2ee99aace80bf3549251`.
- Previous Worker version: `26c88e52-3318-4389-8df7-cc7b0c83ae60`.
- Manifest phase `verified`, clean source; schema `0034`; 34 migration companions
  passed; none applied. Recovery manifest/bookmark retained privately.
- Independent health/readiness returned 200/ok and matched version, revision
  and source digest. Eight admin chunks and the stylesheet matched built bytes;
  Overview includes the update notice. Nine anonymous admin endpoints, including
  `/api/v1/admin/updates`, rejected access with 401/no-store.
- Actionlint passed. All 236 local links in changed Markdown files resolved.
  Staged and all reachable-history Gitleaks passed with redacted output.
- No new authenticated staging business mutation, credential removal, mail
  delivery or provider inference was performed for this release. Prior dated
  records provide scoped delivery/provider evidence; local browser layout/update
  checks use synthetic APIs. Self-review only.

## Dependency audit — unresolved

GitHub reported dependency alerts during source publication. A fresh `pnpm audit`
against the pinned lockfile reported 1 critical, 13 high, 18 moderate and 4 low
findings. GitHub's alert count includes separate manifest/lockfile alerts and is
not directly comparable to this audit count. Secret scans do not address these
dependency findings.

| Dependency | Observed version | Location | Relevant patched version |
| --- | --- | --- | --- |
| Happy DOM | 15.11.7 | Web/Vitest test DOM | 20.8.9 covers the reported critical/high advisories |
| Vite | 6.0.7 | Development server/build/Vitest | 6.4.3 covers the reported high advisories |
| Seroval | 1.6.2 | TanStack Router frontend dependency | 1.6.3 |
| Sharp | 0.35.4 | Miniflare/Wrangler tooling; install scripts disabled | 0.35.5 |
| source-map-js | 1.2.1 | Tailwind build tooling | 1.2.2 |
| js-yaml | 4.3.1 | ESLint tooling | 4.3.2 |
| brace-expansion | 1.1.18 / 2.1.4 | ESLint/minimatch tooling | 1.1.20 / 2.1.5 |
| braces | 3.0.3 | ESLint/fast-glob tooling | 3.0.4 |

The critical finding is [Happy DOM VM context escape](https://github.com/advisories/GHSA-37j7-fg3j-429f).
The frontend dependency includes [Seroval TypedArray memory exhaustion](https://github.com/advisories/GHSA-jp82-f5mq-hwhp).
The dependency paths were checked with `pnpm why`; severity is not a reachability
assessment. These dependencies were not upgraded as part of source publication,
and exploitation or absence of exploitation in the deployed application was not
demonstrated. Dependency remediation and regression checks remain outstanding.

Private evidence is under `.tmp/release-100-*`; the recovery manifest is in
`.tmp/release-100-recovery/release.json`. Raw logs, credentials and artifacts are
excluded from Git.

## Completed GitHub publication

- Stable [Unimailbox 1.0.0](https://github.com/UniMailbox/Unimailbox/releases/tag/v1.0.0)
  published at 2026-10-12 19:28:58 Asia/Shanghai. Public `releases/latest` returns
  `v1.0.0`, `draft: false`, `prerelease: false`; body matches the reviewed notes.
- Annotated tag `v1.0.0` resolves to `847b8e60d5b5386764d5172176ef9a2955602bc6`,
  the reviewed main commit. Its only changes since the staging application
  revision are the release notes and this QA record. No tag was moved.
- [Draft release workflow](https://github.com/UniMailbox/Unimailbox/actions/runs/38242008491)
  passed main ancestry, the full gate, tag/version matching and draft creation.
- [Main Verify](https://github.com/UniMailbox/Unimailbox/actions/runs/38241975450)
  and [tag Verify](https://github.com/UniMailbox/Unimailbox/actions/runs/38242008574)
  passed. Main CI independently reports 1,357 + 987 + 24 = 2,368 passing tests.
- Main/tag secret scans and main CodeQL passed. Existing dependency advisories
  above remain unresolved; those checks do not establish security clearance.
- Publication creates source archives and Release metadata. It does not deploy
  production or verify GitHub notification delivery or external mail receipt.
