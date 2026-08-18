import type { UniMailboxQueueJob, Env } from "../platform/config";
import { createAppContext } from "../app-context";
import { processOutboundJob } from "../modules/outbound-mail";
import { handleIndexBatch } from "../modules/agent/indexer";
import { captureWorkerQueueError } from "../platform/sentry";

export async function handleQueueBatch(
  batch: MessageBatch<UniMailboxQueueJob>,
  env: Env,
  context: ExecutionContext,
): Promise<void> {
  const indexBatch: MessageBatch<{ mailbox_id: string; message_id: string }> =
    batch as unknown as MessageBatch<{
      mailbox_id: string;
      message_id: string;
    }>;
  if (indexBatch.queue === "unimailbox-inbox-index") {
    await handleIndexBatch(indexBatch, env);
    return;
  }
  const appContext = await createAppContext(env, context);
  for (const message of batch.messages) {
    try {
      if (message.body.kind === "orphan_object_cleanup") {
        for (const objectKey of message.body.objectKeys) {
          await appContext.attachmentStore.delete(objectKey);
        }
        appContext.logger.info("maintenance.orphan_objects.cleaned", {
          count: message.body.objectKeys.length,
          jobId: message.body.jobId,
        });
      } else {
        await processOutboundJob(appContext, message.body);
      }
      message.ack();
    } catch (error) {
      captureWorkerQueueError(error, {
        attempts: message.attempts,
        kind: message.body.kind ?? "outbound",
      });
      message.retry();
    }
  }
}
