# 0011 message embeddings

- Purpose: persist the Vectorize-side metadata for each embedded message so the indexer can reconcile upserts, re-embed after model changes, and surface which `messages` rows currently have a vector. Vectorize itself stores the raw vectors; this table only records the `(message_id, mailbox_id, vector_id, model, dim, embedded_at)` tuple.
- Compatibility window: the table is new and has no readers yet. No changes to existing message reads or writes.
- Expected duration: instant.
- Backfill: none — embeddings are populated lazily by the stage 2 indexer once a queue consumer is wired up.
- Verification: `migrations/meta/0011_message_embeddings.verify.sql` returns one row.
- Recovery: drop the table once the indexer is no longer needed; never edit this file after release.
