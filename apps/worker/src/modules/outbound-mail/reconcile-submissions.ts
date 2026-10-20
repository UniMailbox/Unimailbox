import {
  parseProviderKey,
  type AuditEventWriter,
  type OutboundProviderAdapter,
  type ProviderKey,
} from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { decrypt, importEncryptionKey } from '../../platform/crypto';
import { systemClock, type Clock } from '../../platform/clock';
import { logger } from '../../platform/logger';
import { OUTBOUND_RECONCILE_TIMEOUT_MS } from '../../platform/outbox-config';
import { claimAttemptsForReconciliation, acceptOutboundAttempt } from './attempt-repository';
import { finalizeAcceptedSubmission } from './finalize-submission';

/** No evidence (including a failed/empty lookup) ever calls send or releases the send fence. */
export async function reconcileOutboundSubmissions(deps: {
  db: Database;
  encryptionKey: () => Promise<string>;
  resolveAdapter: (key: ProviderKey) => OutboundProviderAdapter | undefined;
  auditEventWriter: AuditEventWriter;
  clock?: Clock;
}) {
  const clock = deps.clock ?? systemClock;
  const attempts = await claimAttemptsForReconciliation(deps.db, clock.now());
  let failed = false;
  let encryptionKey: Promise<CryptoKey> | undefined;
  for (const attempt of attempts) {
    try {
      if (attempt.status !== 'accepted') {
        if (attempt.correlated === 0) continue;
        const connection = await deps.db
          .prepare(
            `SELECT c.provider_key,c.status,k.ciphertext,k.iv,k.auth_tag
          FROM outbound_jobs j JOIN provider_connections c ON c.id=j.provider_connection_id
          JOIN encrypted_credentials k ON k.id=c.credential_id WHERE j.id=?`,
          )
          .bind(attempt.job_id)
          .first<{
            provider_key: string;
            status: string;
            ciphertext: ArrayBuffer;
            iv: ArrayBuffer;
            auth_tag: ArrayBuffer;
          }>();
        if (
          !connection ||
          connection.provider_key !== attempt.provider_key ||
          connection.status !== 'active'
        )
          throw new Error('Submission reconciliation connection unavailable');
        const adapter = deps.resolveAdapter(parseProviderKey(attempt.provider_key));
        if (!adapter?.findSubmission) continue;
        if (adapter.key !== attempt.provider_key)
          throw new Error('Provider lookup adapter mismatch');
        const apiKey = await decrypt(
          {
            ciphertext: new Uint8Array(connection.ciphertext),
            iv: new Uint8Array(connection.iv),
            authTag: new Uint8Array(connection.auth_tag),
          },
          await (encryptionKey ??= deps.encryptionKey().then(importEncryptionKey)),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            adapter.findSubmission(
              {
                timeoutMs: OUTBOUND_RECONCILE_TIMEOUT_MS,
                env: {
                  PROVIDER_API_KEY: apiKey,
                  ...(attempt.provider_key === 'brevo' ? { BREVO_API_KEY: apiKey } : {}),
                },
              },
              attempt.id,
            ),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('Provider reconciliation timeout')),
                OUTBOUND_RECONCILE_TIMEOUT_MS,
              );
            }),
          ]);
          if (!result) continue;
          if (
            typeof result.providerMessageId !== 'string' ||
            !result.providerMessageId.trim() ||
            result.providerMessageId.length > 1024 ||
            !Number.isFinite(Date.parse(result.acceptedAt))
          )
            throw new Error('Invalid reconciliation evidence');
          await acceptOutboundAttempt(deps.db, attempt.id, result, clock.now());
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      await finalizeAcceptedSubmission(deps.db, attempt.id, clock.now(), deps.auditEventWriter);
    } catch {
      failed = true;
      logger.warn(
        {
          event: 'outbound.reconciliation_failed',
          ...(attempt.request_id ? { requestId: attempt.request_id } : {}),
        },
        { code: 'SUBMISSION_RECONCILIATION_FAILED' },
      );
    }
  }
  if (failed) throw new Error('Outbound submission reconciliation failed');
}
