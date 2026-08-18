import type { Env } from "../../platform/config";
import { redactText } from "../mcp/pii";
import { embedMessage } from "./embed";

interface IndexJob {
  mailbox_id: string;
  message_id: string;
}
interface IndexRow {
  subject: string;
  text_body: string;
  html_body: string;
}
export async function handleIndexBatch(
  batch: MessageBatch<IndexJob>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const job = msg.body;
      const row = await env.DB.prepare(
        "SELECT subject, text_body, html_body FROM messages m JOIN mailbox_messages mm ON mm.message_id = m.id WHERE m.id = ? AND mm.mailbox_id = ? LIMIT 1",
      )
        .bind(job.message_id, job.mailbox_id)
        .first<IndexRow>();
      if (!row || !env.VECTORIZE) {
        msg.ack();
        continue;
      }
      const text = redactText(
        `${row.subject}\n${row.text_body || row.html_body}`,
      );
      const vectorId = `${job.mailbox_id}:${job.message_id}`;
      const mutation = await env.VECTORIZE.upsert([
        {
          id: vectorId,
          values: await embedMessage(env, text),
          namespace: job.mailbox_id,
          metadata: {
            message_id: job.message_id,
            snippet: redactText(row.text_body).slice(0, 512),
          },
        },
      ]);
      await env.DB.prepare(
        "INSERT INTO message_embeddings (message_id, mailbox_id, vector_id, model, dim, embedded_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(message_id) DO UPDATE SET vector_id = excluded.vector_id, model = excluded.model, dim = excluded.dim, embedded_at = excluded.embedded_at",
      )
        .bind(
          job.message_id,
          job.mailbox_id,
          vectorId,
          "@cf/baai/bge-base-en-v1.5",
          768,
        )
        .run();
      void mutation;
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}
