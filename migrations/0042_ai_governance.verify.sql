SELECT '0042_tables' AS assertion, count(*)=5 AS pass FROM sqlite_master WHERE type='table' AND name IN ('ai_governance_policy','ai_attempts','ai_legacy_requests','ai_governance_breaker','ai_user_limits');
SELECT '0042_safe_default' AS assertion, count(*)=1 AS pass FROM ai_governance_policy WHERE revision=0 AND mode='observe';
SELECT '0042_active_index' AS assertion, count(*)=1 AS pass FROM sqlite_master WHERE type='index' AND name='ai_attempts_active_idx';
SELECT '0042_registered' AS assertion, count(*)=1 AS pass FROM d1_migrations WHERE name='0042_ai_governance.sql';
