-- Editor uploads live in R2; only capability hashes and metadata live in D1.
CREATE TABLE editor_assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  mailbox_id TEXT REFERENCES mailboxes(id),
  domain_id TEXT REFERENCES managed_domains(id),
  secret_hash TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 67108864),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK ((mailbox_id IS NOT NULL AND domain_id IS NULL) OR (domain_id IS NOT NULL AND mailbox_id IS NULL))
);
CREATE INDEX editor_assets_pending ON editor_assets(expires_at);
CREATE INDEX editor_assets_owner ON editor_assets(owner_user_id);
-- A durable usage protects historical mail and signatures from pending cleanup.
CREATE TABLE editor_asset_usages (
  asset_id TEXT NOT NULL REFERENCES editor_assets(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('message', 'signature')),
  resource_id TEXT NOT NULL,
  PRIMARY KEY (asset_id, resource_type, resource_id)
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0029_editor_assets.sql');

-- Enforce pending quotas atomically as simultaneous uploads finish.
CREATE TRIGGER editor_assets_pending_quota BEFORE INSERT ON editor_assets
WHEN (SELECT COUNT(*) FROM editor_assets a WHERE a.owner_user_id=NEW.owner_user_id AND NOT EXISTS(SELECT 1 FROM editor_asset_usages u WHERE u.asset_id=a.id)) >= 100
 OR (SELECT COALESCE(SUM(size_bytes),0) FROM editor_assets a WHERE a.owner_user_id=NEW.owner_user_id AND NOT EXISTS(SELECT 1 FROM editor_asset_usages u WHERE u.asset_id=a.id)) + NEW.size_bytes > 268435456
BEGIN
 SELECT RAISE(ABORT, 'EDITOR_ASSET_PENDING_LIMIT');
END;
