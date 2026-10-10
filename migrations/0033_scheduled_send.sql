-- Durable scheduling uses the existing outbox, Queue and recovery trigger.
-- NULL retains immediate-send behavior for every existing job.
ALTER TABLE outbound_jobs ADD COLUMN scheduled_at TEXT;
ALTER TABLE outbound_jobs ADD COLUMN mailbox_id TEXT REFERENCES mailboxes(id);
ALTER TABLE outbound_jobs ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0033_scheduled_send.sql');
