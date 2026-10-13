# MCP KV request reduction — staging, 2026-10-13

The personal MCP panel previously polled every 30 seconds even when disabled,
and the global browser authenticator looked up MCP credentials in KV before
MCP's own D1 authentication. This change removes both sources of extra reads
and the MCP cards' additional session-query subscriptions and layered retries.
Design and refresh behavior: `docs/rebuild/19-mcp-service.md`.

## Release

- Target: existing `https://staging.unimailbox.tech`, Cloudflare account
  `6f215b03c5ff77ef28410254e9701d67`; staging CACHE namespace
  `058a382c046940aa8c24f37a066db803`.
- Application commit: `e24bf275da5cb67fd3b9e59246b5bcff259e79e7`.
- Source digest: `d4bbe164fb22a238114e938f1eafd3a06048750eb2c89643e19f87a18168df27`.
- Worker: `fd7fa1b2-5d45-49ea-9e70-9b90753edf72`.
- Previous Worker: `b5a54cc1-476f-4ee8-9d9d-4e887916412b`.
- Frontend digest: `fac1ab4068fb43601cbcebf2515bdf0c2e1a4e89f65f7a010dc091230842a045`.
- Standard `pnpm deploy:staging` completed against clean committed release inputs.
  Doctor 14/14, generated binding drift, lint, TypeScript, builds and **2,393 tests**
  passed: 1,370 non-Worker, 997 Worker and 26 migration fixture tests.
- Account/resources/secrets, D1 recovery bookmark, all 36 SQL companions, exact
  source/version, schema 0036, completed setup, assets/security headers and
  protected/missing-path smoke checks passed. No migration was applied; no
  resource, encryption key, provider, routing or production change was made.
- Readiness and maintenance health passed `pnpm ops:check --environment staging`.

## Operation-count evidence

The actual Hono entry is called with real Worker-pool D1/KV bindings and a test
execution context. Spies observe the binding methods without replacing their
behavior. A positive browser personal-API request performs exactly one
`CACHE.get(auth:<browser token>)`; an anonymous request remains 401. This positive
control establishes that the spies see the cache used by that entry.

After clearing the positive control, MCP discovery, reading a fixture message,
creating a fixture draft, wrong-audience rejection, hostile Origin rejection,
revocation and disabled service perform **zero CACHE get/put/delete/list calls**.
Current credential, account, mailbox and role checks still run in D1. Existing
send, expiry, rate, body and idempotency suites also pass.

Frontend tests simulate one hour with the service enabled and disabled: the
initial personal-settings read stays at **one**, with **zero additional `/auth/me`
reads** from the MCP component. Focus and reconnection do not refetch. Explicit
refresh produces one new read and applies the changed enabled state; unmounting
and reopening produces one further fresh read even with cached data. A 503 is
not retried by the API client or Query layer. Creation/revocation still refresh
metadata through their existing mutation callbacks.

This removes the panel's potential 120 idle settings requests/hour per visible
tab. Opening settings, intentional refreshes, mutations and ordinary browser
API authentication still produce necessary reads. It does not promise zero
account-wide KV usage or weaken live authorization.

## Live acceptance and limits

A protected operator login verified ordinary personal settings and issued one
short-lived read-only credential for one already-accessible mailbox. Remote MCP
initialization, exact read-tool discovery, scoped mailbox listing, browser-token
rejection, hostile Origin rejection and revoked-credential denial passed.

The temporary credential was revoked, original configuration was retained or
restored, and the diagnostic login was explicitly logged out. No account or
mailbox grants were created. No private mail content was fetched and no real
email was sent. A final invalid-credential request returned 401: MCP is enabled
in the retained live configuration. This task did not disable the user's service.

The published frontend entry and AI services chunk contain the new explicit
refresh controls. Those asset checks and component tests are not real browser
or local-agent interaction proof. The zero-KV counts above come from binding
fixtures; a complete post-release day of aggregate analytics has not been
observed. Existing historical telemetry access returned 403 and was not expanded.

Review was a main-agent self-review. Staged Gitleaks v8.30.1 and diff whitespace
checks passed. Code and evidence commits remain local; no push or PR was created.
