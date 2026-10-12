# Deploy Unimailbox with an agent

Follow this guide when asked to create a usable Unimailbox installation. Run
commands from the repository root. Paths in this guide are repository-relative;
example domains must be replaced with the operator's choices. Release internals,
upgrades and recovery are described in [the release runbook](deploy.md).

For an existing installation, follow [the update guide](updates.md) to check
upstream releases, preserve fork changes and resources, back up data and verify
the upgrade. Do not repeat bootstrap or initial setup for a routine update.

## Supported deployment and completion criteria

The runtime is Cloudflare Workers with D1, R2, two KV namespaces, an outbound
queue and its dead-letter queue, Worker Assets and three Secrets Store bindings.
A build machine or CI runner publishes these resources; the repository does not
provide a standalone Node server, Docker mail server, SMTP server or VPS runtime.
Incoming mail uses Cloudflare Email Routing and outgoing mail currently uses the
Brevo adapter. Do not infer support from unused provider names in design history.

An installation is **usable** when an administrator can sign in, an authorized
user can access an assigned mailbox, incoming external mail appears there, and
outgoing mail and replies arrive at an authorized external recipient. Verify a
small attachment upload/download as well. A successful build, `/readyz`, provider
acceptance or a completed wizard is only part of this evidence.

## Collect inputs and check prerequisites

Inspect `git status --short --branch`, recent commits, `.nvmrc`, `package.json`,
the selected config and existing release records before edits or remote writes.
Preserve unrelated work; use an isolated checkout if it prevents mixing changes.
For an existing installation, retain its resource IDs and encryption key and use
the upgrade flow in the release runbook instead of creating replacement data.

Record these inputs without recording secret values:

| Input or condition | Required for | Check |
| --- | --- | --- |
| Cloudflare account ID and authenticated account membership | Publication | `pnpm wrangler whoami --json`; check membership in the intended account without exposing auth tokens. |
| Access to Workers, D1, R2, KV, Queues and Secrets Store | Publication | Confirm product availability, billing prerequisites and plan limits for that account. Bootstrap must be able to create missing resources and read existing ones. |
| Domain managed by Cloudflare in the intended account | App and incoming mail | Confirm the active zone and ability to manage the hostname and Email Routing. App custom domains require a Cloudflare-managed zone. |
| App hostname, such as `mail.example.com` | Publication | Choose an unused hostname or explicitly authorized replacement; `APP_ORIGIN` must be its HTTPS origin without a path. |
| Mail domain, such as `example.com` | Incoming and outgoing mail | Distinguish this from the app hostname; inspect current MX and routing before cutover. |
| Administrator email and password | Setup | Use an address the operator can read. The setup password accepts 6–30 characters; display name is optional. Use private input/storage. |
| Brevo API key and sending permission | Outgoing mail | The wizard validates the key through Brevo. Check account activation, restrictions and quota. Secrets go through the setup form or protected API input. |
| Authenticated mail domain / verified senders in Brevo | Outgoing mail | Verify `noreply@<mail-domain>` for the setup smoke test and every mailbox address used for real sending. Complete the DNS records requested by Brevo. |
| External test sender and recipient authorized by the user | Delivery acceptance | Obtain authorization for the specific test mail; do not send to arbitrary addresses. The setup outbound test sends to the administrator email. |
| Protected recovery storage | Publication and recovery | Preserve the generated encryption key outside the deployment machine. A D1 backup alone cannot recover encrypted provider credentials. |
| Exact pinned toolchain | Preparation | Install the Node version in `.nvmrc`, pnpm from `packageManager`, and the frozen lockfile; use the workspace Wrangler wrapper. |

Prefer `pnpm wrangler login` for interactive operator authentication. In CI,
provide a scoped `CLOUDFLARE_API_TOKEN` as an environment secret. Its permissions
must cover the selected account's Workers deployment, custom-domain/zone access,
D1, R2, KV, Queues and Secrets Store operations. Check the current
[Cloudflare token documentation](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
and the actual failed operation when a token is denied; do not switch accounts
or create a broad token automatically. Dashboard Email Routing/DNS administration
is a separate prerequisite from a deployment token.

If inputs are missing, ask once for the missing account/domain choices or a
protected credential channel, and continue independent local preparation. Once
authorized, carry the selected deployment through its checks. Request further
approval only for work outside that scope, such as replacing existing MX/routing,
modifying a different installation or sending to additional recipients.

## 1. Prepare the toolchain and target

```sh
nvm use
pnpm install --frozen-lockfile
pnpm scaffold doctor
pnpm wrangler --version
pnpm wrangler whoami --json
```

If `nvm` is unavailable, use another installer for the exact pinned Node version.
Do not use a global Wrangler or let a package runner fetch a newer CLI.

For a **new** production installation, create
`apps/worker/wrangler.production.jsonc` from
`apps/worker/wrangler.production.example.jsonc`. If the canonical file already
exists, inspect it before replacement: the public repository includes maintainer
deployment targets. Keep an existing operator installation's config intact.
Preview has its own example; a new staging target can use the preview example
with all `preview` environment identities changed consistently to `staging`.

| Config field | Set or retain |
| --- | --- |
| `account_id` | The operator's own 32-character account ID. |
| `name`, `vars.ENVIRONMENT` | `unimailbox-production`, `production`; use matching identities for staging or preview. These names are enforced by release tooling. |
| `routes[].pattern`, `custom_domain` | The app hostname and `true`. Keep `workers_dev: false`. |
| `vars.APP_ORIGIN` | `https://<app-hostname>`; must exactly match the configured custom domain. |
| D1 database, R2 bucket, outbound queue and DLQ names | Keep the selected environment prefix, for example `unimailbox-production-`; do not reuse another installation's data resources. |
| D1 ID, the two KV IDs and Secrets Store IDs | Leave `PROVISION` for a fresh bootstrap. If reusing resources, resolve and verify their exact identities instead. |
| Secrets Store binding names | Retain `INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`, `CURSOR_SIGNING_KEY`; each needs a distinct environment-prefixed `secret_name`. |
| Assets, queue consumer, metadata and Cron | Retain the template topology, including `OUTBOUND_DLQ`, `VERSION` and the five-minute Cron. The release tool sets `RELEASE_SHA` and `RELEASE_TREE`. |

The environment's origins, databases, buckets, queues, KV namespaces and secret
identities must be isolated. A Secrets Store itself may hold separate secrets
for several environments. If the account has multiple stores, choose one explicit
`store_id`; automatic selection refuses ambiguity. An existing
`CLOUDFLARE_ACCOUNT_ID` or `ENVIRONMENT` variable must agree with the selected
config. Never use `wrangler.dev.jsonc`, `wrangler.test.jsonc` or their public
fixture values for a release.

## 2. Bootstrap and protect the keys

```sh
pnpm scaffold bootstrap --environment production --dry-run
pnpm scaffold bootstrap --environment production
```

The bootstrap dry run validates the proposed configuration and prints a plan;
it does not check remote membership or availability. The real bootstrap checks
membership, provisions missing declared resources, writes resolved IDs into the
canonical config and creates missing secrets using independent random values.
Existing active secrets are preserved. Inactive/ambiguous secrets cause failure.

The generated values are saved with 0600 permissions under the ignored
`.tmp/secret-recovery/` tree. Transfer them to the operator's secret manager,
especially `CREDENTIAL_ENCRYPTION_KEY`; never copy them into a prompt, report,
config `vars`, Git or CI artifact. Metadata commands cannot retrieve their values.
If an existing installation token has no authorized recovery copy, the runbook
supports explicit token rotation; encryption-key rotation is a separate migration.

Review the resolved config and Git diff. Production preparation requires clean,
committed release inputs. Commit only reviewed installation configuration when
the task authorizes committing, or obtain that final local commit from the
operator. Use local commits or a private deployment fork for operator changes;
publishing them to the upstream project is not required. Do not stage unrelated
work or private recovery files. Complete this before preparing the release.

## 3. Prepare and publish

```sh
pnpm scaffold deploy --environment production --dry-run
```

This runs the full local gate, builds fresh assets and validates the environment
bundle. It writes a prepared release manifest under `.tmp/releases/` and prints
its path. It makes no remote writes, but reads the previous deployment identity.
Use that exact path for publication:

```sh
pnpm scaffold deploy --environment production --prepared .tmp/releases/<account>/production/<release>/release.json
```

The path above is a placeholder, not a command to paste unchanged. Publication
checks resource/secret metadata, captures the D1 recovery bookmark, applies
missing ordered migrations, verifies the schema, deploys the prepared source and
assets, and runs HTTP smoke checks. Source/config/asset changes invalidate a
prepared release. Use `--environment staging` or `preview` consistently for
those targets; only staging and production have package-script aliases.

If publication fails, inspect the active version and manifest before retrying.
The Worker may already have been published. Do not bypass migrations, replace
the encryption key, delete D1 or silently roll back to a version with incompatible
schema. See [recovery](deploy.md#rollback-and-data-recovery).

## 4. Complete setup and configure mail

Open `https://<app-hostname>/setup` in a browser. Use the protected installation
token and walk the steps in order:

| Step | Action and evidence |
| --- | --- |
| Claim | Enter `INSTALLATION_TOKEN`. Claim returns a short-lived setup session; re-claim if it expires and resume the recorded step. |
| Preflight | Require all reported bindings to pass and the schema to match the deployed source. Also require `/readyz` to pass; do not hardcode a migration number from an old report. |
| Administrator | Create the first administrator before any completion/skip operation. Check the form succeeded. |
| Domain | Add the mail domain, not automatically the app hostname. Additional domains can be added later in `/admin/domains`. |
| Cloudflare | In the domain's Email Routing dashboard, configure the requested DNS/MX records and route the intended recipients to this exact Email Worker. Enable catch-all routing only if the operator requested it. |
| Incoming test | Use the wizard's generated test address and an authorized external sender; wait for actual arrival. The routing confirmation button alone does not query Cloudflare or prove DNS/delivery. |
| Brevo | Enter the private API key. The app validates and encrypts it, creates the provider connection and links the setup domain. |
| Outgoing test | The wizard sends from `noreply@<mail-domain>` to the administrator email. Verify actual arrival in that mailbox; a provider message ID alone does not prove delivery. |
| Complete | Finalize only after the required setup and mail checks. Sign in at `/login` and confirm access to the application. |

Protect existing mail during DNS/routing changes: inspect current MX, forwarding
rules and provider authentication records, preserve their evidence privately, and
execute the operator's approved cutover plan. Routing is configured outside the
app; the wizard's confirmation is an operator assertion.

The administrator account is a login identity, not an automatically provisioned
business mailbox. Create a mailbox under the managed domain, select its outgoing
connection, and assign access through Admin Users. Verify the test user can open
that assigned mailbox and send as its address.

**Do not skip required mail steps to claim a usable service.** Skipping completes
and locks the wizard. Post-setup pages have narrower capabilities: connections
can be inspected and existing webhook secrets revealed, but full provider
onboarding and setup resumption are not available as a complete UI flow. See
[post-setup capabilities and gaps](post-setup-admin-urls.md).

For API-driven agents, the supported setup sequence is under `/api/v1/setup`:
`GET /status`, then `POST /claim`, `/preflight`, `/administrator`, `/domain`,
`/cloudflare/verify`, `/inbound-smoke-test`, `/brevo`, `/outbound-smoke-test`,
`/complete`. Poll `GET /inbound-smoke-test/check` for actual incoming arrival;
replaying the same idempotent POST check can return an earlier cached result.
Claims take `{token}`, administrator creation
takes `{email,password,displayName?}`, domain takes `{name}`, and Brevo takes
`{apiKey}`; the remaining mutations use `{}`. Follow the actual
[request contracts](../../packages/contracts/src/index.ts) and
[setup routes](../../apps/worker/src/http/routes/setup.ts). Setup mutations require
`Idempotency-Key` (8–128 characters from `[A-Za-z0-9_-]`); after claim they also
require `Authorization: Bearer <setup-session>`. Keep one key for retries of the
same operation/body, and a new key for a changed operation/body. Store secret
request/response bodies privately, suppress token output and resume from status;
do not bypass setup through direct database inserts.

## Optional settings and their limits

| Option | Default / effect | How to configure and verify |
| --- | --- | --- |
| `INBOUND_CATCH_ALL_MAILBOX` | Unset; unmatched recipients are rejected. | Set a mailbox address in config `vars`, create that active mailbox, and verify delivery for its domain. It is an app fallback; it does not enable Cloudflare's catch-all routing rule. Explicit mailbox matches take precedence. |
| `INBOUND_FORWARD_TO` | Unset; no external copy. | Set as a private Worker secret with `pnpm wrangler secret put INBOUND_FORWARD_TO --config wrangler.production.jsonc`. Requires a valid catch-all mailbox config and a verified external Email Routing destination outside that mail domain. Test the copy; do not create a forwarding loop. |
| AI assistance | Disabled. | Use the AI configuration panel in `/admin/settings`; choose Workers AI, Anthropic or OpenAI protocol, model, timeout and output limit. External-provider credentials are stored encrypted. Keep the template AI binding for Workers AI; no external AI account is needed for basic mail. |
| Additional domains and users | One setup domain and administrator initially. | Add domains in `/admin/domains`, create mailboxes and grant access in Admin Users. Configure routing and verified senders for each domain independently. |
| Site title, mailbox and upload limits, retention | See typed defaults. | Configure supported fields in `/admin/settings`; [settings contract](../../packages/contracts/src/admin/settings.ts) owns names/ranges. Test the effective behavior; a stored setting is not proof every path enforces it. |
| Brevo delivery webhooks | Separate from basic send/receive. | Follow Brevo's [transactional webhook instructions](https://developers.brevo.com/docs/transactional-webhooks) and the existing connection's URL/authentication shown in Admin Connections. The current UI can reveal an already configured secret, but does not provision a missing one; report that gap rather than inventing a setup command. Verify authenticated events in the app before claiming delivery-status synchronization. |
| CI publishing | Optional. | `.github/workflows/deploy.yml` uses the chosen GitHub environment and its private `CLOUDFLARE_API_TOKEN`. Bootstrap separately; commit reviewed resolved configuration to the operator's deployment repository. Serialize local/CI releases. |

Better Auth variables, public registration, Turnstile keys, SMTP/POP3 transports
and alternate storage backends are not prerequisites for the current deployment.
Some retained design/schema names describe compatibility or future work. Do not
add undocumented environment variables or claim those features are enabled.

The optional upstream release check is enabled by default. The administrator
overview displays version notices after this code is deployed. See
[update settings and privacy](updates.md#administration-overview) for
`UPDATE_CHECK_ENABLED`, caching, permission requirements and GitHub subscription.

## Verify and hand off

Use the configured origin, not a fixed maintainer hostname:

```sh
pnpm ops:check --environment production
```

For a new installation, allow the first scheduled cycle to run before assessing
maintenance. Inspect failures rather than accepting a permanently missing
heartbeat. Complete this evidence table for the selected installation:

| Check | Required result |
| --- | --- |
| `/healthz`, `/readyz` | HTTP 200, `ok: true`, expected deployed version/source, matching migrated schema. |
| `/healthz/maintenance` | Healthy scheduled recovery, D1 outbox age and dead-letter queue. |
| Setup and static assets | Fresh install opens `/setup`; after completion `/login` and the app load, with the current hashed frontend assets. |
| Anonymous `/api/v1/admin/overview` | HTTP 401 after setup completes. |
| Administrator and assigned user | Successful sign-in; mailbox access matches the grant. A user without a grant cannot read another mailbox. |
| External incoming mail | One visible message in the intended mailbox from the authorized sender. |
| Outgoing message and reply | Actual arrival at the authorized external recipient, with correct sender and reply content. |
| Small attachment | Upload, send/receive and authenticated download work; downloaded bytes match the controlled file. |
| Optional features selected by the operator | Their own live checks pass, or their limits/blockers are explicitly recorded. |

Report the origin, environment, deployed version and source revision, checks
passed, optional settings enabled, and any precise blocker. Keep passwords,
sessions, API keys, private message bodies and complete download URLs out of the
report. If no external sender/recipient or provider access is available, report
publication/setup separately and keep mail usability unverified.

Common blockers: account/permission denial, unavailable Secrets Store, unresolved
`PROVISION` IDs, conflicting environment/account variables, uncommitted production
inputs, changed prepared source, expired setup session, missing routing/MX, unknown
recipient with no mailbox, unverified Brevo sender, provider quota or a stale
Cron heartbeat. Fix the underlying condition and retry the documented step.

Provider references: [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[Email Workers](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
[Secrets Store](https://developers.cloudflare.com/secrets-store/), and
[Brevo API](https://developers.brevo.com/docs/getting-started). Check provider
availability and restrictions against these current sources during deployment.
