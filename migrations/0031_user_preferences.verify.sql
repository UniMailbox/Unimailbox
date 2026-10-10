SELECT '0031_preferences' AS assertion, COUNT(*) = 1 AS pass FROM sqlite_master WHERE type='table' AND name='user_preferences';
SELECT '0031_user_fk' AS assertion, COUNT(*) = 1 AS pass FROM pragma_foreign_key_list('user_preferences') WHERE "table"='users' AND on_delete='CASCADE';
SELECT '0031_mailbox_fk' AS assertion, COUNT(*) = 1 AS pass FROM pragma_foreign_key_list('user_preferences') WHERE "table"='mailboxes' AND on_delete='SET NULL';
SELECT '0031_tracking' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name='0031_user_preferences.sql';
PRAGMA foreign_key_check;
