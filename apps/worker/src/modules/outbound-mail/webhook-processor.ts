// Provider-neutral webhook orchestration. The adapter authenticates raw bytes
// and interprets provider events; this module owns connection-scoped lookup,
// message state transitions and the delivery row prepared for a D1 audit batch.

import type { WebhookProviderAdapter } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import { systemIds } from '../../platform/ids';
import { sqliteTimestamp } from '../../platform/idempotency';
import { prepareUpdateMessageStatus } from '../messages';
import {
  findJobByProviderMessageId,
  getProviderConnection,
  prepareCreateWebhookDelivery,
} from './webhook-repository';

export interface VerifyAndProcessEventInput {
  readonly db: Database;
  readonly connectionId: string;
  readonly providerKey: string;
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string | null;
  readonly adapter: WebhookProviderAdapter | undefined;
}

export interface VerifyAndProcessEventResult {
  readonly messageId: string | null;
  readonly providerMessageId: string | null;
  readonly preparedStatements: {
    readonly statements: ReadonlyArray<D1PreparedStatement>;
  };
}

/** Build the business writes; the route appends audit and commits one D1 batch. */
export async function verifyAndProcessEvent(
  input: VerifyAndProcessEventInput,
): Promise<VerifyAndProcessEventResult> {
  const { db, connectionId, providerKey, rawBody, signatureHeader, adapter } = input;
  const connection = await getProviderConnection(db, connectionId);
  if (
    !connection ||
    connection.provider_key !== providerKey ||
    connection.status !== 'active' ||
    !adapter ||
    adapter.key !== providerKey
  ) {
    throw new DomainError({
      code: 'WEBHOOK_CONNECTION_NOT_FOUND',
      message: 'Connection not found',
      httpStatus: 404,
    });
  }
  if (!connection.webhook_secret) {
    throw new DomainError({
      code: 'WEBHOOK_NOT_CONFIGURED',
      message: 'Webhook secret not configured',
      httpStatus: 409,
    });
  }

  // The adapter verifies the raw bytes before decoding and parsing JSON.
  const event = await adapter.verifyAndParse({
    rawBody,
    signatureHeader,
    secret: connection.webhook_secret,
    receivedAtMs: Date.now(),
  });

  // The provider message ID is account-scoped; never resolve it globally.
  const job = event.providerMessageId
    ? await findJobByProviderMessageId(db, connectionId, event.providerMessageId)
    : null;
  const messageId = job?.message_id ?? null;
  const now = sqliteTimestamp(new Date());
  const statements: D1PreparedStatement[] = [];
  if (messageId !== null && event.status !== null) {
    statements.push(
      prepareUpdateMessageStatus(db, {
        messageId,
        status: event.status,
        providerEventTimeMs: event.eventTimeMs,
        now,
      }),
    );
  }

  // Persist unmatched events too. Queue reconciliation links and replays them
  // once the provider message ID is recorded on the outbound job.
  statements.push(
    prepareCreateWebhookDelivery(db, {
      id: systemIds.uuid(),
      connectionId,
      eventType: event.eventType,
      rawPayload: event.rawPayload,
      providerMessageId: event.providerMessageId,
      messageStatus: event.status,
      messageId,
      eventTimeMs: event.eventTimeMs,
      eventTimeSource: event.eventTimeSource,
      createdAt: now,
    }),
  );

  return {
    messageId,
    providerMessageId: event.providerMessageId,
    preparedStatements: { statements },
  };
}
