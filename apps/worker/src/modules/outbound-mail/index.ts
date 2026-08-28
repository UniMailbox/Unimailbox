// apps/worker/src/modules/outbound-mail/index.ts — CAP-014, CAP-023, CAP-025, CAP-028.
// Public API for the outbound-mail module. Exports the repository
// functions, the queue-consumer use case, and their input types.
//
// Per .claude/rules/architecture.md: a module's index.ts is its entire
// public API; everything else is private.

export {
  prepareCreateCredential,
  getCredentialByName,
  type CreateCredentialInput,
} from './credential-repository';

export { prepareCreateConnection, type CreateConnectionInput } from './connection-repository';

export {
  prepareCreateOutboundJob,
  // CAP-047: marker-guarded INSERT...SELECT for the draft→queued send path.
  // Lives in the same D1 batch as the idempotency record so a replay cannot
  // produce a second outbound_jobs row.
  prepareCreateOutboundJobGuarded,
  getOutboundJob,
  updateJobStatus,
  claimOutboundJob,
  markOutboundJobSent,
  markOutboundJobRetryable,
  markOutboundJobTerminal,
  reclaimStaleOutboundJobs,
  findOrphanedQueuedJobs,
  isJobTerminal,
  type CreateJobInput,
  type CreateJobGuardedInput,
  type OutboundJobRow,
  type UpdateJobStatusInput,
  type ReclaimResult,
} from './job-repository';

export { processOutboundJob, type ProcessJobDeps } from './process-outbound-job';

export { reclaimStaleJobs, type OutboundJobEnqueuer } from './reclaim-stale-jobs';

export {
  createWebhookDelivery,
  prepareCreateWebhookDelivery,
  ensureWebhookSecret,
  getProviderConnection,
  getWebhookSecretForConnection,
  findJobByProviderMessageId,
  findUnmatchedDeliveriesByProviderMessageId,
  prepareBackfillDeliveryMessageId,
  listWebhookDeliveries,
  listProviderConnections,
  type WebhookDeliveryInput,
  type ProviderConnectionForWebhook,
  type WebhookDeliveryRow,
  type ProviderConnectionRow,
  type WebhookSecretRow,
  type UnmatchedWebhookDeliveryRow,
} from './webhook-repository';

export {
  verifyAndProcessEvent,
  type VerifyAndProcessEventInput,
  type VerifyAndProcessEventResult,
} from './webhook-processor';

// CAP-040: early-event reconciliation. Called by processOutboundJob after
// markOutboundJobSent so any webhook_deliveries row whose message_id is
// NULL (the event arrived before the consumer wrote provider_message_id)
// is back-filled and audited.
export {
  reconcileWebhookDeliveries,
  prepareReconciliationStatements,
  type ReconcileResult,
} from './reconcile-webhook-deliveries';
