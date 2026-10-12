# scripts/

Top-level repository scripts invoked via `pnpm scaffold <subcommand>`. The
dispatcher lives in `scripts/scaffold.ts` and routes each subcommand to its
own script file. Run commands from the repository root.

`pnpm scaffold doctor` runs `scripts/doctor.ts`, which performs structural
checks (binding names, migration shape, module dependency zones, tsconfig
strict, etc.) and exits 0 on a healthy repo or 1 with a clear list of
problems. It is the first gate in `.claude/rules/testing.md` §Quality gates.

| Command | Purpose |
| --- | --- |
| `pnpm scaffold doctor` | Structural validation |
| `pnpm scaffold db:migrate` | Apply and verify local D1 migrations |
| `pnpm scaffold db:migrate --verify` | Verify the existing local schema |
| `pnpm scaffold bootstrap --environment production` | Provision missing resources and independent secrets for the selected target |
| `pnpm scaffold deploy --environment production --dry-run` | Verify and prepare a release |
| `pnpm scaffold deploy --environment production --prepared <manifest>` | Publish the exact prepared release and verify it |
| `pnpm ops:check --environment production` | Check dependency and maintenance health |
| `pnpm scaffold secret:rotate --environment production --secret INSTALLATION_TOKEN` | Explicitly rotate a supported named secret |

Use `preview`, `staging` or `production` consistently where the command accepts
an environment. Read [the agent deployment guide](../docs/operations/agent-deploy.md)
before remote operations and [the release runbook](../docs/operations/deploy.md)
for upgrades and recovery. The dispatcher rejects unknown flags and does not
support skipping migrations or bulk secret replacement.
