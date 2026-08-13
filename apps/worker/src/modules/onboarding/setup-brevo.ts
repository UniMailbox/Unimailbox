// setup-brevo use case — POST /api/v1/setup/brevo. CAP-014.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// The operator enters their Brevo API key. The system validates it via the Brevo API,
// encrypts it with AES-GCM (ADR-007), stores the encrypted credential and provider
// connection, links the connection to the managed domain, and advances the step
// to 'outbound-smoke'.
//
// R-SECRET-002: Provider API keys live in encrypted_credentials, encrypted with AES-GCM.
// R-SECRET-003: Secrets are never logged, never returned in an API response.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import type { OutboundProviderAdapter, ProviderRuntimeContext } from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import { encrypt, importEncryptionKey } from '../../platform/crypto';
import { prepareCreateCredential } from '../outbound-mail/credential-repository';
import { prepareCreateConnection } from '../outbound-mail/connection-repository';
import { prepareUpdateInstallationStep } from './installation-state-repository';

export interface SetupBrevoInput {
  readonly db: Database;
  readonly encryptionKey: string;
  readonly apiKey: string;
  readonly adapter: OutboundProviderAdapter;
}

export interface SetupBrevoResult {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly status: string;
}

/**
 * D1's UNIQUE constraint violation message for the provider_connections
 * provider_key index. Used as a defensive backstop for race conditions.
 */
const UNIQUE_PROVIDER_VIOLATION = 'UNIQUE constraint failed';

/**
 * Sets up the Brevo provider connection.
 *
 * 1. Validates the API key by calling the Brevo account API.
 * 2. Encrypts the key with AES-GCM using the CREDENTIAL_ENCRYPTION_KEY.
 * 3. Stores the encrypted credential and provider connection in a single D1 batch.
 * 4. Links the connection to the managed domain.
 * 5. Advances the installation step to 'outbound-smoke'.
 *
 * All D1 writes are atomic — if any step fails, none are applied.
 *
 * @throws DomainError PROVIDER_CONNECTION_FAILED (502) if the API key is invalid.
 * @throws DomainError SETUP_BREVO_ALREADY_CONFIGURED (409) if Brevo is already configured.
 */
export async function setupBrevo(
  input: SetupBrevoInput,
  deps: { clock: Clock; ids: IdGenerator },
): Promise<SetupBrevoResult> {
  // 1. Validate the API key via the adapter before encrypting.
  const ctx: ProviderRuntimeContext = {
    env: { BREVO_API_KEY: input.apiKey },
  };
  await input.adapter.validateConnection(ctx);

  // 2. Encrypt the API key with AES-GCM.
  const key = await importEncryptionKey(input.encryptionKey);
  const encrypted = await encrypt(input.apiKey, key);

  // 3. Generate IDs and timestamp.
  const credentialId = deps.ids.uuid();
  const connectionId = deps.ids.uuid();
  // SQLite datetime format: 'YYYY-MM-DD HH:MM:SS'
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  // 4. Batch: credential insert + connection insert + domain update + step advance.
  const stmts = [
    prepareCreateCredential(input.db, {
      id: credentialId,
      name: 'brevo-api-key',
      version: 1,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      createdAt: now,
      updatedAt: now,
    }),
    prepareCreateConnection(input.db, {
      id: connectionId,
      providerKey: 'brevo',
      label: 'Brevo',
      credentialId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }),
    input.db
      .prepare(
        'UPDATE managed_domains SET outbound_connection_id = ?, updated_at = ? WHERE id = (SELECT id FROM managed_domains LIMIT 1)',
      )
      .bind(connectionId, now),
    prepareUpdateInstallationStep(input.db, 'outbound-smoke', now),
  ];

  try {
    await input.db.batch(stmts);
  } catch (err) {
    // Defensive backstop: race condition where two requests pass validation
    // simultaneously. D1's UNIQUE constraint catches this.
    if (err instanceof Error && err.message.includes(UNIQUE_PROVIDER_VIOLATION)) {
      throw new DomainError({
        code: 'SETUP_BREVO_ALREADY_CONFIGURED',
        message: 'Brevo is already configured',
        httpStatus: 409,
      });
    }
    throw err;
  }

  return {
    connectionId,
    providerKey: 'brevo',
    status: 'active',
  };
}
