-- 0003_provider_connections.sql — CAP-014 provider connections table.
-- Stores provider connections (Brevo, Resend, CF-Sendmail, etc.) with a
-- foreign key to encrypted_credentials. The status field tracks whether
-- a connection is active, disabled by the operator, or invalid (e.g.
-- provider API rejected the credential).
--
-- ADR-002: Modules call adapters through the OutboundProviderAdapter
-- interface. ADR-007: Provider API keys live in encrypted_credentials.
CREATE TABLE IF NOT EXISTS provider_connections (
  id              TEXT PRIMARY KEY,
  provider_key    TEXT NOT NULL,
  label           TEXT NOT NULL,
  credential_id   TEXT NOT NULL REFERENCES encrypted_credentials(id),
  status          TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'invalid')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_provider_connections.sql');
