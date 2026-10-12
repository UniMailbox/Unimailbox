# Upstream update notifications — 2026-10-12

Historical implementation evidence below records the original local scope and
self-review. Publication completed later on 2026-10-12; see
[1.0.0 release QA](../../docs/qa/release-1.0.0-2026-10-12.md).

## Behavior

- Users subscribe to upstream **Watch → Custom → Releases**. Forking alone does
  not subscribe them or update their deployment.
- Upstream stable tags on `main` run full verification and a matching product
  version check before creating a Release draft. Only the canonical repository
  runs this workflow. A maintainer reviews and publishes the draft as Latest.
- Administration → Overview reads `GET /api/v1/admin/updates`, protected by
  `settings.read`, and displays base version/revision and safe external links.
  The upstream GitHub request is fixed and anonymous, with a five-second timeout
  and bounded body. Stable numeric versions are compared; no-release, failure,
  disabled, equal and ahead states remain distinct. Raw notes/URLs are discarded.
- KV caches successful checks for six hours and failures for 15 minutes. Page
  queries refresh hourly while open and use user-scoped cache keys. Optional
  `UPDATE_CHECK_ENABLED=false` disables upstream access. No automatic deployment.
- [Upgrade instructions](../../docs/operations/updates.md) cover preserving fork
  changes, configuration, resource identities and keys, backups, migrations,
  verified deployment and authorized mail acceptance. Existing installs do not
  repeat bootstrap/setup during routine upgrades.

## Owned implementation

`packages/contracts/src/release.ts` owns product version and shared projection;
`index.ts` exports it. Worker changes are `platform/updates.ts`, optional Env,
`http/routes/admin-updates.ts` and router registration. Web changes are
`features/admin/{update-queries,UpdatePanel,AdminLandingPage}` and the added
leading update translations in `infrastructure/i18n/zh-CN.ts`. Their focused
tests accompany them. `.github/workflows/release.yml` owns release drafting.
README, AGENTS, deployment/update guides, ledger and log provide navigation.

Preserved earlier public documentation changes and parallel mailbox-tag
selector work. Did not edit those parallel source/style changes or their tests.

## Evidence

- Focused contract, fetch, frontend and real local KV/D1 permission tests: 32
  passed. Covers numeric versions, unsafe tags/URLs, timeout/body size, disabled
  access, cache expiry, rate limits, no release, anonymous/member denial,
  read permission, private response, language and permission revocation.
- Original dirty worktree `pnpm verify` encountered the ongoing mailbox selector's
  old checkbox test. An isolated checkout based on `bb126eb`, containing owned
  changes and the earlier documentation changes, passed the full canonical gate:
  doctor 14/14, generated bindings, lint, TypeScript, builds, 1,351 non-Worker,
  987 Worker and 24 migration tests (2,362 total). Owned application sources and
  update translations were compared byte-for-byte with this snapshot.
- Release fixture tags were subsequently made relative to the base major
  version so future version bumps retain valid tests; the seven affected Worker
  checks passed again. Application behavior was unchanged.
- Actionlint 1.7.12 (checksum verified), focused formatting, diff, deployment
  links/shell examples and scoped redacted secret scans passed.
- Agent-browser: synthetic API desktop 1440×1000 and mobile 390×844; English and
  Chinese notice, manual check and correct release/guide links. Mobile document
  width stayed within the viewport; no browser errors. No real administrator
  session or live deployed version check was exercised.
- Public GitHub latest-release endpoint returned 404; authenticated release
  listing returned no releases on 2026-10-12. API version 2026-03-10 was accepted.

## Publication follow-up

Source and reviewed deployment/update documentation were committed and pushed to
upstream main. Product version is 1.0.0. The immutable v1.0.0 tag matches main's
reviewed release commit; its complete GitHub gate created a draft, which was
published with reviewed notes as Latest. The matching application code/assets
are deployed to staging; no production deployment was performed for this release.

Actual notification delivery and an authenticated live administrator-panel check
remain unverified. The dependency audit has unresolved advisories recorded in
release QA and the public notes; functional/secret scans are not security clearance.
