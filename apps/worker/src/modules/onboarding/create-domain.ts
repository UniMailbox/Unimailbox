// create-domain use case — POST /api/v1/setup/domain.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// The operator creates a managed domain during setup. After successful creation,
// the installation step advances from 'domain' to 'cloudflare-verify'.
//
// The domain insert + step update are batched as one D1 transaction (coding.md
// §Data: "Multi-row writes that must be atomic go in a single D1 batch").
// If either fails, both roll back — preventing a wedged setup state where
// the domain exists but the step didn't advance.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import type { DomainName } from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import { prepareCreateDomain } from '../tenancy';
import { prepareUpdateInstallationStep } from './installation-state-repository';

export interface CreateDomainInput {
  readonly db: Database;
  readonly name: DomainName;
}

export interface CreateDomainResult {
  readonly domainId: string;
  readonly name: string;
  readonly status: string;
}

/**
 * D1's UNIQUE constraint violation message for the managed_domains.name index.
 * Used as a defensive backstop for race conditions. The primary guard is
 * the existence check at the top of the use case.
 */
const UNIQUE_DOMAIN_VIOLATION = 'UNIQUE constraint failed: managed_domains.name';

/**
 * Creates a managed domain and advances the installation step to 'cloudflare-verify'.
 *
 * R-DATA-001: Domain name is case-insensitive (lowercased before insert).
 * ManagedDomain invariant: name is UNIQUE. Only one domain can be created during setup.
 * New domains start with status='active'.
 *
 * @throws DomainError DOMAIN_ALREADY_MANAGED (409) if a domain already exists.
 * @throws DomainError DOMAIN_NAME_TAKEN (409) on race-condition duplicate name.
 */
export async function createDomainStep(
  input: CreateDomainInput,
  deps: { clock: Clock; ids: IdGenerator },
): Promise<CreateDomainResult> {
  // Guard: only one domain can be created during setup.
  // Check BEFORE generating ID to avoid wasted work.
  const existing = await input.db.prepare('SELECT 1 FROM managed_domains LIMIT 1').first();
  if (existing) {
    throw new DomainError({
      code: 'DOMAIN_ALREADY_MANAGED',
      message: 'A domain has already been managed',
      httpStatus: 409,
    });
  }

  const domainId = deps.ids.uuid();
  // SQLite datetime format: 'YYYY-MM-DD HH:MM:SS' — matches datetime('now')
  // default in the DDL and the test-kit FIXED_TIMESTAMP convention.
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  // Prepare both statements and run them as one D1 batch (atomic).
  // If either fails, both roll back — preventing a wedged setup state.
  const insertDomain = prepareCreateDomain(input.db, {
    id: domainId,
    name: input.name,
    status: 'active',
    outboundConnectionId: null,
    createdAt: now,
    updatedAt: now,
  });
  const advanceStep = prepareUpdateInstallationStep(input.db, 'cloudflare-verify', now);

  try {
    await input.db.batch([insertDomain, advanceStep]);
  } catch (err) {
    // Defensive backstop: race condition where two requests pass the
    // existence check simultaneously. D1's UNIQUE constraint catches this.
    if (err instanceof Error && err.message.includes(UNIQUE_DOMAIN_VIOLATION)) {
      throw new DomainError({
        code: 'DOMAIN_NAME_TAKEN',
        message: 'A domain with this name already exists',
        httpStatus: 409,
      });
    }
    throw err;
  }

  return { domainId, name: input.name, status: 'active' };
}
