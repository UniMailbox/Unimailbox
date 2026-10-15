# Updates for independent installations

Forking keeps a copy of the source. It does not subscribe the operator to upstream
releases, synchronize their fork or upgrade their running Worker. Source updates
and deployed-service updates are separate operations.

## Receive release notifications

On [the upstream repository](https://github.com/UniMailbox/Unimailbox), choose
**Watch → Custom → Releases → Apply**. Configure GitHub's notification settings
for email, the GitHub inbox or both. Watch upstream even when your deployment
uses a fork. A star or fork alone is not a release subscription.

Review the [Releases page](https://github.com/UniMailbox/Unimailbox/releases) for
migrations, configuration changes, security fixes and rollback limits. A source
push, a tag without a published Release or an unpublished draft does not
constitute a stable release announcement. GitHub owns notification delivery and
each user's preferences; maintainers do not automatically subscribe fork owners
or email them.

## Administration overview

After installing code containing this feature, **Administration → Overview**
shows the installed upstream base version and source revision, checks for the
latest stable release, and links its notes and this guide. The read endpoint
`GET /api/v1/admin/updates` requires `settings.read`. It has no deployment action.

The Worker requests GitHub's fixed public `releases/latest` endpoint without a
token, user identity, installation hostname, mail data or credentials. GitHub
still receives the normal network request from Cloudflare. Checks occur when the
overview is used; they do not send email or run a scheduled background job.
Successful results, including no published release, are cached in installation
KV for six hours. Errors are cached for 15 minutes to limit retries. The page
refreshes its query hourly while open. **Check for updates** rereads that cache;
it does not bypass the server's rate limit protection.

Only stable `vMAJOR.MINOR.PATCH` tags are accepted and compared numerically.
Drafts and prereleases are excluded. No release, unavailable checks, disabled
checks, equal versions and versions ahead of upstream have distinct messages.
`0.0.0` is the development baseline. Custom fork code is compared by its upstream
base version; equality does not prove identical source or patch compatibility.
Use the displayed revision to identify the deployed source.

To disable external checks, add `"UPDATE_CHECK_ENABLED": "false"` to `vars` in
the selected canonical Wrangler configuration and redeploy through the normal
flow. Omit it, or use `"true"`, to enable checks. This optional setting needs no
GitHub key. Network/API/KV failure displays an unavailable result and leaves
administration and mail operations available. Older installations need one
deliberate upgrade before this panel exists; GitHub subscription works independently.

## Update a fork and its installation

Choose a published stable upstream tag. The fork's default branch or the latest
upstream commit is not necessarily a tested release.

1. Inspect the branch, worktree, remotes, deployed source/schema and release
   notes. Preserve uncommitted work and identify custom changes, especially the
   installation's account/domain/resource configuration.
2. Back up D1 and R2 using the [recovery runbook](deploy.md#rollback-and-data-recovery).
   Retain matching encryption keys in the operator's secret manager. Verify
   recovery and record the previous Worker version before migrations. Code
   rollback cannot undo data changes or recover missing object bytes.
3. Verify the upstream remote, then fetch the chosen tag and merge on a dedicated
   branch. Commands assume a clean deployment branch; replace `<release-tag>`
   with a published tag. Skip `remote add` when the verified remote exists:

   ```sh
   git remote -v
   git remote add upstream https://github.com/UniMailbox/Unimailbox.git
   TARGET_RELEASE='<release-tag>'
   git fetch upstream tag "$TARGET_RELEASE"
   git switch -c "upgrade/$TARGET_RELEASE"
   git merge --no-ff "$TARGET_RELEASE"
   ```

   Stop on tag conflicts; do not force-replace a fork's tag. Resolve merge
   conflicts by reviewing both implementations. GitHub's **Sync fork** can
   synchronize source, but does not deploy the application. Do not force-sync
   a deployment branch with local patches.
4. Review the merge, migrations and examples. Preserve the real account, app
   hostname, mail domains, D1/R2/KV/Queue identities, Secrets Store bindings and
   optional settings. Upstream maintainer targets are not defaults. Preserve
   key values. Existing installations do not need bootstrap or setup again.
   Commit reviewed configuration corrections locally before production
   preparation and record the merge/tag used.
5. Use the current toolchain and [normal release flow](deploy.md#prepare-and-publish):

   ```sh
   nvm use
   pnpm install --frozen-lockfile
   pnpm deploy:production --dry-run
   pnpm deploy:production --prepared '<printed-release-manifest>'
   pnpm ops:check --environment production
   ```

   Replace the manifest placeholder with the path printed by preparation. Use
   the operator's selected environment; test staging first when available.
   Production needs clean, committed application/config inputs. Review schema
   compatibility with the previous Worker before applying migrations. Do not
   restore a database as part of routine upgrading.
6. Confirm health/readiness source and schema, sign-in, mailbox grants, real
   incoming/outgoing/reply behavior and attachment bytes using authorized test
   addresses. Check the overview's version and revision. Record failures and
   rollback limits; a merged fork alone is not a completed upgrade.

Agent request template:

> Read AGENTS.md, docs/operations/updates.md and the deployment runbook. Upgrade
> my existing installation to the stable upstream release I specify. Verify my
> account, environment, domain, deployed source/schema, custom fork changes and
> backup recovery first. Preserve resources and existing keys; do not repeat
> initial setup. Complete the authorized merge, checks and deployment, then
> verify the service with my approved test addresses. Report before/after
> versions, revisions, migrations, acceptance evidence and blockers. Keep private
> data and credentials out of Git and reports.

## Publish upstream releases (maintainers)

The product version is `APPLICATION_VERSION` in
`packages/contracts/src/release.ts`. Cloudflare's Worker UUID, source revision
and workspace package versions are different identifiers. Set a nonzero stable
product version in a reviewed commit on upstream `main`, then create and push
the matching `vMAJOR.MINOR.PATCH` tag through the authorized publication process.

`.github/workflows/release.yml` runs only in `UniMailbox/Unimailbox`, checks that
the tagged commit belongs to upstream `main`, runs `pnpm verify`, checks that tag
and product version agree, and creates a **draft** GitHub Release. It does not
deploy Cloudflare resources or publish releases in forks.

Review and edit the generated draft notes to describe user-visible changes,
migrations/configuration requirements, security impact, known limits, backup and
rollback requirements, and the upgrade guide. Confirm runtime acceptance for
the release scope. Publish the reviewed draft as a stable Release and mark it
**Latest**. Publication enables subscribed GitHub release notifications and the
overview's stable version check. Reuse an existing draft on workflow retries;
never move a published tag. Issue a new version for corrections. Prereleases
created separately do not appear in this stable update panel.

The workflow and UI announce a release only after an operator publishes the
reviewed draft. They do not upgrade an installation automatically.

References: [GitHub notifications](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications),
[syncing a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork),
and [latest-release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).
