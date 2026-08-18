SELECT CASE
  WHEN (
    SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='agent_tokens'
  ) = 1
  AND (
    SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name='idx_agent_tokens_user'
  ) = 1
  AND (
    SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name='idx_agent_tokens_hash'
  ) = 1
  AND (
    SELECT COUNT(*) FROM permissions WHERE key IN ('ai.read', 'ai.write', 'schedule.write')
  ) = 3
  AND (
    SELECT COUNT(*)
    FROM role_permissions
    WHERE permission_key IN ('ai.read', 'ai.write', 'schedule.write')
      AND role_id = '00000000-0000-4000-8000-000000000001'
  ) = 3
  THEN 1
  ELSE 0
END AS agent_tokens_valid;
PRAGMA foreign_key_check;