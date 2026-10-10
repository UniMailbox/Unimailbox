// inbound-smoke-test — POST /api/v1/setup/inbound-smoke-test.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// Generates a smoke test address (smoke+<token>@<domain>), stores the token in KV,
// and verifies receipt when the email arrives. This is the first capability that
// modifies the inbound email handler (previously a reject-all stub).
//
// Flow:
// 1. Operator clicks "Start Inbound Smoke Test" → POST /inbound-smoke-test
// 2. Worker generates smoke+<uuid>@<domain> and returns it
// 3. Operator sends an email from their email client to that address
// 4. Cloudflare Email Routing forwards the email to the Worker's email handler
// 5. The handler detects the smoke+ prefix, validates the token, sets a KV flag
// 6. Operator clicks "Check" → POST /inbound-smoke-test/check
// 7. Worker finds the KV flag → advances step to 'brevo'

import type { Database } from '../../platform/database';
import type { Cache } from '../../platform/cache';
import type { Clock } from '../../platform/clock';
import { systemClock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import { getManagedDomain } from '../tenancy';
import { updateInstallationStep } from './installation-state-repository';

const SMOKE_TTL_SECONDS = 300; // 5 minutes
const SMOKE_PREFIX = 'smoke+';

// --- Start ---

export interface StartSmokeTestInput {
  readonly db: Database;
  readonly cache: Cache;
}

export interface StartSmokeTestResult {
  readonly smokeTestAddress: string;
  readonly expiresAt: string;
}

/**
 * Starts the inbound smoke test by generating a unique token and storing it in KV.
 *
 * Checks that a managed domain exists (via tenancy module).
 * Generates a UUID token and stores smoke:{token} in CACHE KV with domain and 5-minute TTL.
 * Also stores smoke:active with the token for the check endpoint.
 * Returns { smokeTestAddress: "smoke+<token>@<domain>" }.
 *
 * Does NOT advance the step — the message hasn't arrived yet.
 *
 * @throws DomainError SETUP_DOMAIN_REQUIRED (409) if no domain exists.
 */
export async function startInboundSmokeTest(
  input: StartSmokeTestInput,
  deps: { ids: IdGenerator; clock?: Clock },
): Promise<StartSmokeTestResult> {
  const domain = await getManagedDomain(input.db);
  if (!domain) {
    throw new DomainError({
      code: 'SETUP_DOMAIN_REQUIRED',
      message: 'A managed domain must be created before the smoke test',
      httpStatus: 409,
    });
  }

  const token = deps.ids.uuid();
  await input.cache.put(`smoke:${token}`, JSON.stringify({ domain: domain.name }), {
    expirationTtl: SMOKE_TTL_SECONDS,
  });
  // Track the active token for the check endpoint
  await input.cache.put('smoke:active', token, { expirationTtl: SMOKE_TTL_SECONDS });

  return {
    smokeTestAddress: `${SMOKE_PREFIX}${token}@${domain.name}`,
    expiresAt: new Date(
      (deps.clock ?? systemClock).unixMs() + SMOKE_TTL_SECONDS * 1000,
    ).toISOString(),
  };
}

// --- Check ---

export interface CheckSmokeTestResult {
  readonly status: 'received' | 'pending' | 'expired';
}

/** Polling is read-only; only the explicit confirmation below advances setup. */
export async function readInboundSmokeTestStatus(cache: Cache): Promise<CheckSmokeTestResult> {
  const token = await cache.get('smoke:active');
  if (!token) return { status: 'expired' };
  const result = await cache.get(`smoke-result:${token}`);
  return { status: result ? 'received' : 'pending' };
}

/**
 * Checks whether the smoke test email has been received.
 *
 * Reads smoke:active from CACHE KV to get the current token.
 * Reads smoke-result:{token} from CACHE KV.
 * If found → advance step to 'brevo', return { status: "received" }.
 * If not → return { status: "pending" }.
 */
export async function checkInboundSmokeTest(
  input: { db: Database; cache: Cache },
  deps: { clock: Clock },
): Promise<CheckSmokeTestResult> {
  const result = await readInboundSmokeTestStatus(input.cache);
  if (result.status !== 'received') return result;

  // Received! Advance step to 'brevo'.
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await updateInstallationStep(input.db, 'brevo', now);

  return { status: 'received' };
}

// --- Email handler detection ---

/**
 * Checks if an incoming email is a smoke test message and marks it as received.
 *
 * Parses the `to` address for smoke+<token>@<domain> pattern (case-insensitive).
 * Normalizes token to lowercase for KV lookup.
 * If match and token exists in CACHE KV → sets smoke-result:{token}, returns true.
 * Otherwise → returns false (not a smoke test message).
 *
 * Called by the email handler entrypoint. If this returns true, the message is
 * accepted (not rejected).
 */
export async function handleSmokeTestMessage(to: string, cache: Cache): Promise<boolean> {
  // Parse smoke+<token>@<domain> pattern (case-insensitive)
  const match = to.match(
    /^smoke\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i,
  );
  if (!match) return false;

  // Normalize to lowercase for KV lookup (UUIDs are stored lowercase)
  const token = (match[1] ?? '').toLowerCase();
  // Validate the token is a pending smoke test
  const pending = await cache.get(`smoke:${token}`);
  if (!pending) return false;

  // Mark as received
  await cache.put(`smoke-result:${token}`, '1', { expirationTtl: SMOKE_TTL_SECONDS });
  return true;
}
