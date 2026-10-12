# Agent entry point

For an installation or deployment request, read
[the agent deployment guide](docs/operations/agent-deploy.md) first. It defines
required inputs, optional settings, the supported commands and the checks for a
usable mail service. Confirm the intended account and domain from the user's
request before performing remote operations. A clone's maintainer configuration
is not authorization to modify that account.

For upgrades of an existing installation, also read
[the update guide](docs/operations/updates.md). Preserve custom fork changes,
resource identities and encryption keys; verify backups before migrations.

For development work, follow [CLAUDE.md](CLAUDE.md) and the applicable repository
rules. Preserve unrelated changes, use repository-relative paths in documents,
and never publish secrets or private mail. Continue within the user's authorized
scope; report missing inputs and provider or permission failures precisely.

Distinguish a prepared build, a published Worker, completed setup and verified
mail delivery. Report only the stages demonstrated on the selected installation.
