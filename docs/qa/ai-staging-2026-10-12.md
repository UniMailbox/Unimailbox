# AI foundation staging release — 2026-10-12

## Published source

- Origin: https://staging.unimailbox.tech
- Feature: `850e0d7`; initial design/handoff: `2895ea2`.
- Released revision: `5f85a35b59b789ccadfab2db4b5e1187ae1bcb02`.
- Worker version: `e4981bdf-2992-4794-8e9d-783263925e3d`.
- Source digest: `7cdfa0d4e307f86f817ae8c1b3f64d38ccbd571a4cca94591f4a60d6b2636087`.
- Deployment used `pnpm deploy:staging` and only the staging target configuration.

## Checks

The canonical release gate passed doctor 14/14, generated binding check, lint,
TypeScript, frontend/Worker build and 2,300 tests: 1,305 unit/frontend/contracts/
scripts, 971 Worker and 24 migration fixtures. Redacted Gitleaks 8.30.1 scans
passed for staged content; the pre-fix history scan covered 374 reachable commits.
These scans do not prove the absence of every possible secret.

The first remote run applied migration 0034 but failed its tracking assertion,
so no new Worker was published. Unlike the local migration helper, deployment
executes raw SQL and needs each migration to register itself. Fix `5f85a35` adds
the tracking insert and makes table creation/default seeding safe on a partial
retry without replacing configured state. Raw SQL regression tests prove fresh
registration, recovery and repeated execution. The second release reapplied 0034,
verified all 34 schema companions and published successfully. A D1 recovery
bookmark and release manifests remain in private ignored release artifacts.

Live release smoke passed exact version/source digest, readiness/schema 0034,
completed installation, frontend HTML/security headers, hashed JavaScript cache,
missing assets/source-map/API 404 responses and the protected admin API 401.
Additional live requests confirmed `/healthz` and `/readyz` return 200 with the
released revision/version; GET `/api/v1/admin/ai` and POST the mailbox AI reply
route return `401 AUTHENTICATION_REQUIRED` with `Cache-Control: no-store`.
Cloudflare version metadata confirms the native `AI` binding. Safe D1 projection
shows revision 0, protocol `workers-ai`, disabled service and no API key, with
exactly one migration 0034 tracking record.

## Acceptance boundary

Desktop/mobile Admin and composer interactions were tested earlier using local
synthetic APIs and the real Tiptap editor. This release adds real Cloudflare
publication, schema/binding and HTTP smoke evidence. It does not establish an
authenticated staging AI configuration round trip, real model inference,
provider-specific structured output, output quality or generated-mail delivery.
Enable/configure the desired model in Admin → AI services for that next acceptance.
The run did not publish production or push source commits.


## Configured MiniMax request recovery — 2026-10-12

A later user report supplied request ID
`e301b4c0-9c94-41ad-a087-4c3d49164768`; its content-free audit outcome was
`AI_UPSTREAM_ERROR`. The OpenAI-compatible backend had been configured with model
`Minimax M3`. The [official MiniMax OpenAI SDK guide](https://platform.minimax.cn/docs/api-reference/text-openai-api)
uses exact model ID `MiniMax-M3`; the configured base URL
`https://api.minimax.cn/v1` matches the same guide.

An authenticated, revision-checked Admin GET/PUT changed only that model ID and
advanced configuration revision 1 → 2, preserving the existing encrypted API key
and endpoint. A new AI draft request with synthetic context and no source email
returned HTTP 200 with 229 characters in approximately 3.5 seconds. This proves
one live configured MiniMax generation through the deployed Worker, not model
output quality or structured-output compatibility. The operation sent no email.
No source change or Worker redeployment was necessary for this configuration fix.
The temporary diagnostic login session was revoked after verification.
