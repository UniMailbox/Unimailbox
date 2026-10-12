-- Disabled by default; credential bytes never enter the public JSON projection.
CREATE TABLE ai_configuration (
  id TEXT PRIMARY KEY CHECK (id = 'system'),
  configuration TEXT NOT NULL CHECK (json_valid(configuration)),
  ciphertext BLOB,
  iv BLOB,
  auth_tag BLOB,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((ciphertext IS NULL AND iv IS NULL AND auth_tag IS NULL) OR
         (ciphertext IS NOT NULL AND length(ciphertext) > 0 AND iv IS NOT NULL AND auth_tag IS NOT NULL
          AND length(iv) = 12 AND length(auth_tag) = 16))
);
INSERT INTO ai_configuration (id, configuration) VALUES
('system', '{"enabled":false,"protocol":"workers-ai","model":"","baseUrl":null,"maxOutputTokens":1024,"timeoutMs":30000}');
