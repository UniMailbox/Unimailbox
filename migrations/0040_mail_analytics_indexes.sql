-- Read-only dashboard windows must not scan the full outbox/receipt history.
CREATE INDEX IF NOT EXISTS outbound_jobs_created_at_idx ON outbound_jobs(created_at,id);
CREATE INDEX IF NOT EXISTS inbound_receipts_created_at_idx ON inbound_receipts(created_at,id);
CREATE INDEX IF NOT EXISTS editor_asset_usages_resource_idx ON editor_asset_usages(resource_type,resource_id,asset_id);
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0040_mail_analytics_indexes.sql');
