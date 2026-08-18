import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIndexBatch } from "../../../src/modules/agent/indexer";
import { makeEnv } from "../env-fixture";

const userId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const mailboxId = "11111111-aaaa-4bbb-8ccc-dddddddddddd";
const messageId = "22222222-aaaa-4bbb-8ccc-dddddddddddd";
const mailboxMessageId = "33333333-aaaa-4bbb-8ccc-dddddddddddd";

async function bootstrapFixtures() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, password_hash, password_algorithm, password_salt, password_iterations, status, display_name, created_at, updated_at) VALUES (?, 'o@example.com', 'x', 'pbkdf2-sha256', 'x', 1, 'active', 'Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(userId)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO domains (id, name, status) VALUES ('44444444-aaaa-4bbb-8ccc-dddddddddddd', 'example.com', 'active')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mailboxes (id, domain_id, owner_user_id, address, display_name, status) VALUES (?, '44444444-aaaa-4bbb-8ccc-dddddddddddd', ?, 'owner@example.com', 'Inbox', 'active')`,
  )
    .bind(mailboxId, userId)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, thread_id, from_address, from_name, subject, html_body, text_body, status) VALUES (?, ?, 'a@example.com', 'Alice', 'Subject', '<p>x</p>', 'vector body', 'received')`,
  )
    .bind(messageId, messageId)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mailbox_messages (id, mailbox_id, message_id, folder) VALUES (?, ?, ?, 'inbox')`,
  )
    .bind(mailboxMessageId, mailboxId, messageId)
    .run();
}

describe("INBOX_INDEX_QUEUE consumer", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      env.DB,
      (env as unknown as { TEST_MIGRATIONS?: unknown[] })
        .TEST_MIGRATIONS as never,
    );
  });

  beforeEach(async () => {
    await bootstrapFixtures();
  });

  it("upserts into Vectorize and writes a message_embeddings row", async () => {
    const upserts: unknown[] = [];
    const e = makeEnv();
    const envRecord = e as unknown as {
      VECTORIZE: {
        upsert: (vectors: unknown[]) => Promise<{ mutationId: string }>;
      };
    };
    envRecord.VECTORIZE = {
      ...envRecord.VECTORIZE,
      upsert: async (vectors: unknown[]) => {
        upserts.push(...vectors);
        return {
          mutationId: "test-mutation",
          ids: vectors.map((vector) => (vector as { id: string }).id),
        };
      },
    } as never;
    const ack = vi.fn();
    const batch = {
      messages: [
        {
          body: { mailbox_id: mailboxId, message_id: messageId },
          ack,
          retry: () => undefined,
          attempts: 1,
        },
      ],
      queue: "unimailbox-inbox-index",
    } as unknown as MessageBatch<{ mailbox_id: string; message_id: string }>;
    await handleIndexBatch(batch, e);
    expect(ack).toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    const row = await env.DB.prepare(
      `SELECT mailbox_id, vector_id FROM message_embeddings WHERE message_id = ?`,
    )
      .bind(messageId)
      .first<{ mailbox_id: string; vector_id: string }>();
    expect(row?.mailbox_id).toBe(mailboxId);
    expect(row?.vector_id).toBe(`${mailboxId}:${messageId}`);
  });
});
