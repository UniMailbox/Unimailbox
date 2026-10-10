#!/usr/bin/env -S npx tsx
// scripts/send-test-brevo.ts — CAP-045 Step 4 operator helper.
//
// Sends a real email through Brevo to trigger a real bounce for the
// preview verification gate's audit + webhook chain. Reads the API key
// from the runtime environment; never echoes, logs, or writes the key.
//
// IMPORTANT: this script is intentionally free of credential material.
// Rotate any BREVO_API_KEY that has been in chat / shell history /
// inline argv before running. See .claude/rules/security.md §Secrets.
//
// Usage: pnpm tsx scripts/send-test-brevo.ts --to <addr> --templateId <id>
// Exit codes: 0 Brevo 2xx · 1 any error (generic message; never echoes key)

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const to = get('--to');
  const templateId = get('--templateId');
  if (!to || !templateId) throw new Error('--to and --templateId are required');

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey?.trim()) throw new Error('BREVO_API_KEY env var missing');
  if (apiKey !== apiKey.trim()) throw new Error('BREVO_API_KEY must not contain whitespace');

  let res: Response;
  try {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ to: [{ email: to }], templateId: Number(templateId) }),
    });
  } catch {
    throw new Error('Brevo request failed (network/transport); see wrangler tail');
  }
  if (!res.ok) {
    process.stderr.write(`Brevo returned ${String(res.status)}\n`);
    process.exit(1);
  }
  process.stdout.write(`Sent to ${to} via template ${templateId}\n`);
}
await main();
export {};
