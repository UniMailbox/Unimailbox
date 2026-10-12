# Unimailbox

Unimailbox is an open-source mail application for teams that want to run their
own installation. It supports multiple users, domains and mailboxes, with
administrator-managed accounts and mailbox access.

The application runs on **Cloudflare Workers**, using D1, R2, KV, Queues and
Secrets Store. Incoming mail uses Cloudflare Email Routing; outgoing mail uses
Brevo. The web client and API are served from the same custom domain. A server
or CI runner can build and publish the application, but the current runtime is
Cloudflare; a standalone VPS or Docker deployment is not provided.

## Deploy your own installation

Start with the [agent deployment guide](docs/operations/agent-deploy.md). It
covers required accounts and permissions, configuration, resource creation,
administrator setup, mail routing, optional features and real delivery checks.
The [release and recovery runbook](docs/operations/deploy.md) covers upgrades,
prepared releases, secret management and rollback.

You will need:

- Your own Cloudflare account with access to the required products and a domain
  managed in that account.
- A public HTTPS hostname for the app and a mail domain for incoming addresses.
- A Brevo account, a private API key and verified senders for outgoing mail.
- The Node version in `.nvmrc`, pnpm from `package.json`, and Git.

Use `apps/worker/wrangler.production.example.jsonc` as the starting point for a
new installation. The checked-in staging and production configs describe
maintainer environments: review and replace the selected target with your own
account, domain and resources before running any remote command. Bootstrap
generates independent secrets; development and test values must never be used
in a deployed installation.

The deployment sequence is:

1. Configure and authenticate your target account and environment.
2. Run bootstrap to create missing resources and securely back up the generated
   keys. Commit the reviewed production configuration locally.
3. Prepare and publish a verified release through `pnpm scaffold deploy`.
4. Complete `/setup`, configure incoming routing and Brevo, and create mailboxes.
5. Verify sign-in, real incoming mail, outgoing mail, replies and attachments.

Publishing a Worker alone does not complete mail setup. The guide defines the
checks needed before an installation can be reported as usable.

## Deploy with an agent

[AGENTS.md](AGENTS.md) is the tool-neutral entry point. Give your agent this
request, replacing the example inputs; supply secrets through a protected
credential channel rather than the prompt:

> Read AGENTS.md and docs/operations/agent-deploy.md. Deploy Unimailbox to my
> Cloudflare account using the production environment, app hostname
> mail.example.com and mail domain example.com. Check prerequisites and existing
> resources, list any missing inputs, then complete the authorized deployment and
> setup. Verify real send/receive/reply and attachment behavior using only the
> test addresses I authorize. Report the deployed version, checks passed and any
> remaining blockers. Do not publish credentials.

See [CLAUDE.md](CLAUDE.md) for repository development conventions.

## Stay up to date

On [the upstream repository](https://github.com/UniMailbox/Unimailbox), choose
**Watch → Custom → Releases** to receive release notifications through GitHub.
Forking alone does not subscribe you or update your running installation.
Administration → Overview also checks the latest stable upstream version and
links its release notes. See the [update and fork upgrade guide](docs/operations/updates.md)
for version checks, optional disabling, backups, preserving custom changes and
verified deployment. Existing installations must first upgrade to code containing
the panel. Both channels require a published stable upstream Release.

## Local development

Run commands from the repository root:

```sh
nvm use
pnpm install --frozen-lockfile
```

Create private local secrets in `apps/worker/.dev.vars` before starting a fresh
development installation. If that file already exists, preserve its values;
changing the encryption key makes existing encrypted credentials unreadable.
This command creates a new file with mode 0600 and refuses to overwrite one:

```sh
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const names = ['INSTALLATION_TOKEN', 'CREDENTIAL_ENCRYPTION_KEY', 'CURSOR_SIGNING_KEY'];
const content = names.map((name) => `${name}=${randomBytes(32).toString('hex')}`).join('\n');
writeFileSync('apps/worker/.dev.vars', `${content}\n`, { mode: 0o600, flag: 'wx' });
JS
pnpm build
pnpm scaffold db:migrate
```

Start `pnpm dev:worker` and `pnpm dev:web` in separate terminals. Open
`http://localhost:5173/setup`; the installation token is in your private local
secret file. Vite proxies `/api/*` to the Worker on port 8787; `VITE_WORKER_URL`
can select another local Worker origin. Local bindings simulate Cloudflare
resources. Real incoming delivery requires a deployed Email Worker.

Run `pnpm verify` for the full implementation gate.

## Features and status

The implementation includes administrator-managed accounts, shared mailbox
access, incoming and outgoing mail, rich compose, drafts, replies, scheduled
send, R2 attachments, personal settings, audit logs, and English/Simplified
Chinese. AI assistance is optional and disabled by default.

The [capability ledger](docs/rebuild/capability-ledger.md#current-state) records
current delivery status. [Dated QA reports](docs/qa/) describe observed behavior
and remaining gaps. The [acceptance catalog](docs/qa/acceptance-test-cases.md)
and [execution CSV](docs/qa/acceptance-execution.csv) cover broader acceptance;
they have not been executed as one complete run. Prior deployment evidence does
not verify a new user's installation.

The previous Unimailbox implementation remains in Git history and at
[legacy/pre-rebuild-2026-10-10](https://github.com/UniMailbox/Unimailbox/tree/legacy/pre-rebuild-2026-10-10).
Its database history differs from this application's migrations. Use a fresh
database for a new installation; existing-system migration needs a separate plan.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `apps/worker/` | Hono API and Cloudflare HTTP, email, queue and scheduled handlers |
| `apps/web/` | React, Vite and TanStack Router client |
| `packages/` | Shared contracts, email parsing, configuration and test helpers |
| `migrations/` | Ordered D1 migrations and verification companions |
| `scripts/` | Validation, bootstrap, release and operations commands |
| `docs/operations/` | Deployment and operating guides |
| `docs/rebuild/` | Design decisions and delivery history |

## Security and license

Keep passwords, tokens, provider keys, private mail and complete recipient
download URLs out of Git and public reports. See the
[repository hygiene guide](docs/operations/repository-hygiene.md) for scans and
handling of public test fixtures. Resource IDs are configuration metadata;
credentials belong in protected secret storage.

Unimailbox uses the [GNU Affero General Public License v3](LICENSE). Imported UI
components retain their [upstream license notices](docs/rebuild/licenses/).
