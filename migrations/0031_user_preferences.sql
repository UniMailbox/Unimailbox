-- Identity-owned, relational preferences. Avatar bytes live in private R2.
CREATE TABLE user_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','zh-CN')),
 theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('system','light','dark')),
 density TEXT NOT NULL DEFAULT 'comfortable' CHECK(density IN ('comfortable','compact')),
 reading_pane TEXT NOT NULL DEFAULT 'none' CHECK(reading_pane IN ('none','right','bottom')),
 default_mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
 avatar_object_key TEXT UNIQUE,
 avatar_content_type TEXT CHECK(avatar_content_type IN ('image/png','image/jpeg','image/webp')),
 avatar_version TEXT,
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 CHECK((avatar_object_key IS NULL AND avatar_content_type IS NULL AND avatar_version IS NULL)
    OR (avatar_object_key IS NOT NULL AND avatar_content_type IS NOT NULL AND avatar_version IS NOT NULL))
);
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0031_user_preferences.sql');
