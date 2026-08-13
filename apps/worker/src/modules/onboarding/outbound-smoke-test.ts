// outbound-smoke-test use case — POST /api/v1/setup/outbound-smoke-test. CAP-015.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// Sends a test email via the Brevo adapter. Decrypts the stored API key,
// constructs a test message from noreply@<domain> to the admin's email,
// sends it, and confirms the provider accepted it. Advances step to 'complete'.
//
// R-SECRET-002: Provider API keys live in encrypted_credentials.
// R-SECRET-003: Secrets are never logged, never returned in an API response.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import type {
  OutboundProviderAdapter,
  ProviderRuntimeContext,
  SendProviderMessage,
} from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import { importEncryptionKey, decrypt } from '../../platform/crypto';
import { getFirstUser } from '../identity';
import { getManagedDomain } from '../tenancy';
import { getCredentialByName } from '../outbound-mail';
import { updateInstallationStep } from './installation-state-repository';

export interface OutboundSmokeTestInput {
  readonly db: Database;
  readonly encryptionKey: string;
  readonly adapter: OutboundProviderAdapter;
}

export interface OutboundSmokeTestResult {
  readonly providerMessageId: string;
}

/**
 * Runs the outbound smoke test.
 *
 * 1. Reads the admin user (first user in users table).
 * 2. Reads the managed domain.
 * 3. Reads the encrypted Brevo API key credential.
 * 4. Decrypts the API key using AES-GCM.
 * 5. Constructs a test message from noreply@<domain> to admin email.
 * 6. Sends via the Brevo adapter.
 * 7. Advances installation step to 'complete'.
 *
 * @throws DomainError SETUP_ADMINISTRATOR_REQUIRED (409) if no admin exists.
 * @throws DomainError SETUP_DOMAIN_REQUIRED (409) if no managed domain exists.
 * @throws DomainError SETUP_BREVO_NOT_CONFIGURED (409) if Brevo not configured.
 * @throws DomainError PROVIDER_SEND_FAILED (502) if the send fails.
 */
export async function runOutboundSmokeTest(
  input: OutboundSmokeTestInput,
  deps: { clock: Clock; ids: IdGenerator },
): Promise<OutboundSmokeTestResult> {
  // 1. Read admin user
  const admin = await getFirstUser(input.db);
  if (!admin) {
    throw new DomainError({
      code: 'SETUP_ADMINISTRATOR_REQUIRED',
      message: 'No administrator exists',
      httpStatus: 409,
    });
  }

  // 2. Read managed domain
  const domain = await getManagedDomain(input.db);
  if (!domain) {
    throw new DomainError({
      code: 'SETUP_DOMAIN_REQUIRED',
      message: 'No managed domain',
      httpStatus: 409,
    });
  }

  // 3. Read encrypted credential
  const cred = await getCredentialByName(input.db, 'brevo-api-key');
  if (!cred) {
    throw new DomainError({
      code: 'SETUP_BREVO_NOT_CONFIGURED',
      message: 'Brevo not configured',
      httpStatus: 409,
    });
  }

  // 4. Decrypt API key
  const key = await importEncryptionKey(input.encryptionKey);
  const apiKey = await decrypt(
    {
      ciphertext: new Uint8Array(cred.ciphertext),
      iv: new Uint8Array(cred.iv),
      authTag: new Uint8Array(cred.auth_tag),
    },
    key,
  );

  // 5. Construct and send message
  const ctx: ProviderRuntimeContext = {
    env: { BREVO_API_KEY: apiKey },
  };
  const msg: SendProviderMessage = {
    idempotencyKey: deps.ids.uuid(),
    from: { address: `noreply@${domain.name}` },
    to: [{ address: admin.email }],
    cc: [],
    bcc: [],
    subject: 'Unimailbox Setup Smoke Test',
    html: '<p>This is a test message from Unimailbox setup.</p>',
    text: 'This is a test message from Unimailbox setup.',
    attachments: [],
  };

  const result = await input.adapter.send(ctx, msg);

  // 6. Advance step to 'complete'
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await updateInstallationStep(input.db, 'complete', now);

  return { providerMessageId: result.providerMessageId };
}
