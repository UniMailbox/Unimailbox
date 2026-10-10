# CAP-045 — Preview verification gate operator runbook

This runbook captures the seven steps a human operator runs against a real
Cloudflare preview deployment to prove what the harness cannot: real
inbound mail, real provider signature, real DNS, real wrangler tail, real
browser hydration, and a real second deploy no-op.

The companion worker-pool suite (`apps/worker/test/preview-gate.worker.test.ts`)
proves the code-path shape on real bindings; this runbook proves the
substrate. Both are required for CAP-045 to flip from **PARTIAL** (code
complete) to **FULL** (substrate verified).

## Evidence folder

Each step drops artifacts into a per-operator, per-date folder:

```
work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/
```

Replace `<OPERATOR>` with your initials / handle and `<YYYY-MM-DD>` with
today's date. The folder is gitignored-adjacent — capture it but do not
commit its contents to the repo (operator runs on real Cloudflare
resources; evidence is audit material, not source).

## Prereqs

- `pnpm install` clean.
- `BREVO_API_KEY` available via `apps/worker/.dev.vars` (gitignored) or
  shell env. Rotate any key that has been shared in chat — see
  `.claude/rules/security.md`.
- `wrangler` CLI authenticated against the Cloudflare account.
- `INSTALLATION_TOKEN` available in `apps/worker/.dev.vars`.
- `CREDENTIAL_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `CURSOR_SIGNING_KEY`
  either present in the deployed Worker's Secrets Store OR injected via
  `--var` for the preview.
- A verified sending domain in Brevo with SPF/DKIM/DMARC published.
- A bounce-catcher address (e.g. `bounce-catcher@yourdomain.com`) that
  forwards to your inbox so Step 4's bounce actually lands somewhere you
  can read.

## Placeholder

`<DEPLOYED_WORKER_URL>` — the URL wrangler prints after the first deploy
(Step 1).

---

## Step 1 — Deploy + capture URL + secrets

**Proves what the harness cannot:** the deploy substrate (D1, R2, KV,
Queue, Assets, Secrets Store) actually provisions on Cloudflare; the Worker
  accepts traffic; the secrets surface is wired end-to-end.

```bash
ENVIRONMENT=preview pnpm scaffold deploy
```

(`scripts/deploy.ts:62-65` reads `process.env.ENVIRONMENT` — the only
flag the CLI recognises is `--skip-migrate` / `--dry-run` /
`--force-secrets`. The `--environment=` form does NOT exist.)

The deploy script writes `.cloudflare-resources.json` at the repo root
with the D1 id, R2 bucket name, KV ids, queue names, and Secret Store
binding names. Copy that file into the evidence folder:

```bash
mkdir -p work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>
cp .cloudflare-resources.json work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/
```

Capture the deployed URL (wrangler prints
`Deployed to: https://unimailbox-worker-preview.<account>.workers.dev`)
into `deployed-url.txt` in the evidence folder.

Healthz check (deploy script runs this automatically; record the output):

```bash
curl -sS https://<DEPLOYED_WORKER_URL>/healthz | tee \
  work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/healthz.json
```

Expected output: `{ "ok": true, "surface": "router" }`.

---

## Step 2 — Open `wrangler tail` in a second terminal

**Proves what the harness cannot:** real Worker runtime logs (not the
workerd pool's stdout). The tail captures every fetch, every queue ack,
every email invocation, every log line.

```bash
# In a SECOND terminal (keep it open for Steps 3–6):
cd apps/worker && wrangler tail
```

Capture the tail's startup banner into
`wrangler-tail-startup.txt` so reviewers see the runtime version.

---

## Step 3 — Complete setup through all nine steps

**Proves what the harness cannot:** the setup wizard actually creates the
administrator, the Brevo connection (with real API key validation), the
verified domain, and the seed roles. Browser hydration (D-CAP-046-D) only
shows in a real browser.

Open `<DEPLOYED_WORKER_URL>/setup` in a browser. Walk through every step
of the wizard:

1. Claim (paste `INSTALLATION_TOKEN`)
2. Administrator registration (email + password)
3. Cloudflare account link (real OAuth round-trip)
4. Brevo connection (paste `BREVO_API_KEY`)
5. Sending domain (pick from verified list)
6. Signature
7. Mailbox
8. Member invite (optional)
9. Complete

Capture:
- A screenshot of the final `/setup/complete` confirmation page →
  `setup-complete.png`.
- The `audit_events` row count via the API (proves the audit trail was
  written during setup):
  ```bash
  curl -sS https://<DEPLOYED_WORKER_URL>/api/v1/admin/audit-events \
    -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
    | tee work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/audit-after-setup.json
  ```

---

## Step 4 — Send a real email via the Brevo helper

**Proves what the harness cannot:** real outbound wire (Brevo's actual
`/v3/smtp/email` HTTP request with the real API key, real SPF/DKIM
signature, real envelope-from). Real provider events flow back through the
webhook for Step 5.

```bash
pnpm tsx scripts/send-test-brevo.ts \
  --to <BOUNCE_CATCHER_ADDR> \
  --templateId <BREVO_TEMPLATE_ID>
```

The script reads `BREVO_API_KEY` from env (or `.dev.vars`) — it never
echoes the key, never logs it, never writes it. Runbook note: any leak of
the key that appeared in chat history (terminal scrollback, `wrangler
secret put` argv, etc.) MUST be rotated before this step — see
`.claude/rules/security.md §Secrets`. Never pass `BREVO_API_KEY` as
inline argv to `wrangler secret put`; the process arguments end up in
the shell history and the rotated key becomes needed immediately.

Capture:
- The script's stdout ("Sent to ... via template ...") →
  `brevo-send-result.txt`.
- The `wrangler tail` output from this terminal for the next ~30 seconds
  → `wrangler-tail-after-send.log`. Should show the outbound queue
  consumer draining, the message status advancing to 'sent', the audit
  row being written.
- The Brevo dashboard's "Transactional > Logs" entry for this send →
  `brevo-dashboard-send.png`.

---

## Step 5 — Confirm real inbound + webhook round-trip

**Proves what the harness cannot:** real Cloudflare Email Routing
delivering to the Worker; real provider webhook with valid HMAC signature
hitting `/api/v1/webhooks/:providerKey/:connectionId`.

Reply to the email from Step 4 (so you have a real inbound round-trip).
Use any mail client (Thunderbird, Fastmail web UI, Mail.app); send from
your address to the bounce-catcher:

```bash
# Or paste the body into your mail client's compose window.
echo "Reply body" | swaks -t <BOUNCE_CATCHER_ADDR> -f <YOUR_EMAIL> \
  -s "Re: Preview gate test"
```

In a third terminal, capture the inbound path:

```bash
wrangler tail --format pretty 2>&1 | tee \
  work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/wrangler-tail-inbound.log
```

`--env preview` is NOT a wrangler flag — there is no `env.preview`
section in `wrangler.jsonc`. Run from `apps/worker/` so wrangler picks up
the Worker config.

Expected log shape (truncated):

```
[INFO] email handler invoked
[INFO] message persisted id=abc-123 thread_id=...
[INFO] audit_events row written action=message.receive
```

Then wait ~30s for Brevo to send a webhook event (delivery confirmation).
Check the worker tail for the webhook route invocation:

```
[INFO] /api/v1/webhooks/brevo/<connection-id> invoked
[INFO] HMAC verified
[INFO] webhook_deliveries row reconciled
[INFO] audit_events row written action=webhook.delivered
```

Capture the Brevo dashboard's "Webhook logs" view → `brevo-webhook.png`.

---

## Step 6 — Queue recovery (intentional crash)

**Proves what the harness cannot:** Cloudflare's actual retry policy
kicks in; the Worker sees a real retry; `msg.retry()` (not `ackAll()`) is
called; `outbound_jobs.attempts` increments on the real D1.

The cleanest way without modifying production code: temporarily revoke
the Brevo API key, send another message through the UI, watch the tail:

```bash
# In Brevo dashboard: revoke the active API key (or rotate to a known-bad value).
# Then send via UI; expect:
#   - outbound_jobs.attempts increments
#   - error_message recorded ("Brevo 401" or similar)
#   - the queue applies Cloudflare's backoff up to max_retries
wrangler tail --format pretty 2>&1 | tee \
  work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/wrangler-tail-queue-recovery.log
```

After the retries exhaust, restore the API key. Capture the final
`outbound_jobs` state:

```bash
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT id, status, attempts, error_message FROM outbound_jobs ORDER BY created_at DESC LIMIT 5" \
  | tee work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/outbound-jobs-after-recovery.txt
```

(Replace `DB` with the D1 binding name from `.cloudflare-resources.json`.
If `pnpm exec` does not find `wrangler`, run `cd apps/worker` first.
For a local-dev replay substitute `--local`.)

---

## Step 7 — Repeat deploy (no-op on migrations)

**Proves what the harness cannot:** the pending-only deploy path
(`scripts/deploy.ts`) is the sole migration authority; a second deploy
is genuinely a no-op (no DDL replay, services healthy).

```bash
ENVIRONMENT=preview pnpm scaffold deploy
```

Expected output (lines around the migrations step):

```
Running remote migrations…
No pending migrations (15 already applied).
Deploying worker…
  Deployed to: https://<DEPLOYED_WORKER_URL>
  Healthz check passed.
```

Capture the full deploy stdout →
`deploy-second-run.txt`.

Sanity check — re-fetch the audit log to prove Step 5/6's writes are
still readable:

```bash
curl -sS https://<DEPLOYED_WORKER_URL>/api/v1/admin/audit-events \
  -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
  | tee work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/audit-after-second-deploy.json
```

---

## Closure

Paste:

- The `pnpm test:worker` output from the worker-pool suite (run with
  `BREVO_API_KEY` set so live-mode sub-assertions run).
- The contents of `work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/`.

…back into the CAP-045 row of `docs/rebuild/capability-ledger.md`. The
orchestrator flips the status from **PARTIAL** to **FULL**, writes the
closure implementation-log entry, and archives the contract per
`.claude/rules/documentation.md`.