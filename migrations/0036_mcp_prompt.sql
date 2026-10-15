-- Keep existing service state, credentials, scopes and request limits intact.
-- NULL uses the application default prompt; editing stores a shared template.
CREATE TABLE IF NOT EXISTS mcp_prompt (
  id TEXT PRIMARY KEY REFERENCES mcp_configuration(id) CHECK (id = 'system'),
  prompt_template TEXT CHECK (prompt_template IS NULL OR length(prompt_template) BETWEEN 1 AND 8000)
);
INSERT OR IGNORE INTO mcp_prompt(id) VALUES ('system');
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0036_mcp_prompt.sql');
