// apps/worker/src/modules/outbound-mail/index.ts — CAP-014, CAP-023, CAP-025.
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

export {
  prepareCreateConnection,
  type CreateConnectionInput,
} from './connection-repository';

export {
  prepareCreateOutboundJob,
  getOutboundJob,
  updateJobStatus,
  type CreateJobInput,
  type OutboundJobRow,
  type UpdateJobStatusInput,
} from './job-repository';

export { processOutboundJob, type ProcessJobDeps } from './process-outbound-job';

export {
  createWebhookDelivery,
  ensureWebhookSecret,
  getProviderConnection,
  findJobByProviderMessageId,
  listWebhookDeliveries,
  listProviderConnections,
  type WebhookDeliveryInput,
  type ProviderConnectionForWebhook,
  type WebhookDeliveryRow,
  type ProviderConnectionRow,
} from './webhook-repository';

export {
  verifyAndProcessEvent,
  type VerifyAndProcessEventInput,
  type VerifyAndProcessEventResult,
} from './webhook-processor';