SELECT CASE
  WHEN (
    SELECT COUNT(*) FROM permissions
  ) = 5
  AND (
    SELECT COUNT(*) FROM roles
  ) = 1
  AND (
    SELECT COUNT(*) FROM role_permissions
  ) = 5
  AND (
    SELECT COUNT(*) FROM permissions
    WHERE key IN ('message.read','message.send','mailbox.create','settings.read','settings.manage')
  ) = 5
  AND (
    SELECT COUNT(*) FROM roles WHERE name = 'administrator'
  ) = 1
  AND (
    SELECT COUNT(*) FROM roles WHERE name = 'member'
  ) = 0
  THEN 1
  ELSE 0
END AS migration_verified;
PRAGMA foreign_key_check;
