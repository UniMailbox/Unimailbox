// cloudflare-verify use case — POST /api/v1/setup/cloudflare/verify.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// Confirms a managed domain exists and advances the installation step to
// 'inbound-smoke'. In Phase 1, this is an operator-confirmation step (the
// operator clicks "I've enabled Email Routing"). The actual email-delivery
// verification happens in CAP-013 (inbound smoke test). A real Cloudflare API
// check is deferred to when the integrations/cloudflare/control-plane.ts
// integration lands.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import { DomainError } from '../../platform/errors';
import { getManagedDomain } from '../tenancy';
import { updateInstallationStep } from './installation-state-repository';

export interface CloudflareVerifyInput {
  readonly db: Database;
}

export interface CloudflareVerifyResult {
  readonly verified: true;
  readonly domain: string;
}

/**
 * Verifies Cloudflare Email Routing setup and advances the installation step.
 *
 * Phase 1: Operator-confirmation only. No Cloudflare API call.
 * Checks that a managed domain exists (via tenancy module).
 * If no domain exists, throws SETUP_DOMAIN_REQUIRED (409).
 * Advances step to 'inbound-smoke' after confirmation.
 *
 * The real verification happens in CAP-013 (inbound smoke test) — an actual
 * email must arrive.
 *
 * @throws DomainError SETUP_DOMAIN_REQUIRED (409) if no domain exists.
 */
export async function verifyCloudflareEmailRouting(
  input: CloudflareVerifyInput,
  deps: { clock: Clock },
): Promise<CloudflareVerifyResult> {
  // Verify domain exists before advancing step
  const domain = await getManagedDomain(input.db);
  if (!domain) {
    throw new DomainError({
      code: 'SETUP_DOMAIN_REQUIRED',
      message: 'A managed domain must be created before verifying Cloudflare',
      httpStatus: 409,
    });
  }

  // Advance step to 'inbound-smoke'
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await updateInstallationStep(input.db, 'inbound-smoke', now);

  return { verified: true, domain: domain.name };
}
