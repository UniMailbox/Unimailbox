import type { AiConfigurationResponse, UpdateAiConfiguration } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import { encrypt } from '../../platform/crypto';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  isIdempotencyUniqueViolation,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
} from '../../platform/idempotency';
import { prepareCreateAuditEvent } from './audit-event-repository';
import { prepareUpdateAiConfiguration, readAiConfiguration } from './ai-configuration-repository';

const OPERATION = 'PUT /api/v1/admin/ai';
export async function getAiConfiguration(
  db: Database,
  canManage: boolean,
  workersAiAvailable: boolean,
): Promise<AiConfigurationResponse> {
  const snapshot = await readAiConfiguration(db);
  return {
    configuration: snapshot.configuration,
    revision: snapshot.revision,
    hasApiKey: snapshot.credential !== null,
    canManage,
    workersAiAvailable,
  };
}
export async function updateAiConfiguration(
  db: Database,
  encryptionKey: () => Promise<CryptoKey>,
  input: {
    request: UpdateAiConfiguration;
    expectedRevision: number;
    actorUserId: string;
    idempotencyKey: string;
    requestHash: string;
    requestId: string | null;
    workersAiAvailable: boolean;
  },
): Promise<string> {
  const replay = async (): Promise<string | null> => {
    const record = await findIdempotencyRecord(
      db,
      input.actorUserId,
      OPERATION,
      input.idempotencyKey,
    );
    if (!record) return null;
    assertSameRequestHash(record, input.requestHash);
    return record.responseJson;
  };
  const stored = await replay();
  if (stored !== null) return stored;
  const current = await readAiConfiguration(db);
  if (current.revision !== input.expectedRevision) {
    const stored = await replay();
    if (stored !== null) return stored;
    throw stale();
  }
  const { configuration, apiKey } = input.request;
  let credential = current.credential;
  // Never reuse a credential for another endpoint or protocol.
  if (
    configuration.protocol !== current.configuration.protocol ||
    configuration.baseUrl !== current.configuration.baseUrl ||
    apiKey === null
  )
    credential = null;
  if (configuration.protocol === 'workers-ai') {
    if (apiKey)
      throw new DomainError({
        code: 'VALIDATION_ERROR',
        message: 'Workers AI does not use an API key',
        httpStatus: 400,
      });
    credential = null;
  } else if (apiKey) credential = await encrypt(apiKey, await encryptionKey());
  if (
    configuration.enabled &&
    ((configuration.protocol === 'workers-ai' && !input.workersAiAvailable) ||
      (configuration.protocol !== 'workers-ai' && !credential))
  ) {
    throw new DomainError({
      code: 'AI_NOT_CONFIGURED',
      message: 'Configure the AI binding or API key before enabling AI',
      httpStatus: 400,
    });
  }
  const now = sqliteTimestamp(new Date());
  const response: AiConfigurationResponse = {
    configuration,
    revision: current.revision + 1,
    hasApiKey: credential !== null,
    canManage: true,
    workersAiAvailable: input.workersAiAvailable,
  };
  const responseJson = JSON.stringify({ data: response });
  try {
    await db.batch([
      prepareCreateIdempotencyRecord(db, {
        id: crypto.randomUUID(),
        actorId: input.actorUserId,
        operation: OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 200,
        responseJson,
        createdAt: now,
      }),
      prepareUpdateAiConfiguration(
        db,
        { configuration, credential, revision: current.revision },
        input.expectedRevision,
        now,
      ),
      prepareCreateAuditEvent(db, {
        id: crypto.randomUUID(),
        actorUserId: input.actorUserId,
        action: 'ai.configuration_updated',
        resourceType: 'ai_configuration',
        resourceId: 'system',
        requestId: input.requestId,
        metadata: JSON.stringify({
          protocol: configuration.protocol,
          enabled: configuration.enabled,
          credentialChanged: apiKey !== undefined || current.credential !== credential,
        }),
        createdAt: now,
      }),
    ]);
  } catch (error) {
    if (
      isIdempotencyUniqueViolation(error) ||
      (error instanceof Error && error.message.includes('CHECK constraint failed: revision >= 0'))
    ) {
      const stored = await replay();
      if (stored !== null) return stored;
      throw stale();
    }
    throw error;
  }
  return responseJson;
}
function stale(): DomainError {
  return new DomainError({
    code: 'STALE_IF_MATCH',
    message: 'AI configuration changed. Reload and try again.',
    httpStatus: 412,
  });
}

// Server-only projection for the composition root; ciphertext never reaches HTTP.
export { readAiConfiguration } from './ai-configuration-repository';
