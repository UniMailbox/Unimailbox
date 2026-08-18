PRAGMA foreign_keys = ON;

CREATE TABLE message_embeddings (
  message_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  vector_id TEXT NOT NULL,            -- Vectorize returns id
  model TEXT NOT NULL,                -- '@cf/baai/bge-base-en-v1.5'
  dim INTEGER NOT NULL,
  embedded_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX idx_message_embeddings_mailbox ON message_embeddings(mailbox_id);
CREATE INDEX idx_message_embeddings_embedded_at ON message_embeddings(embedded_at);