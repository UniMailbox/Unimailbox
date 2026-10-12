SELECT '0034_ai_configuration_row' AS assertion, COUNT(*) = 1 AS pass
FROM ai_configuration WHERE id = 'system' AND revision >= 0 AND json_valid(configuration);
SELECT '0034_ai_revision_column' AS assertion, COUNT(*) = 1 AS pass
FROM pragma_table_info('ai_configuration') WHERE name = 'revision' AND type = 'INTEGER' AND "notnull" = 1;
SELECT '0034_tracking' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name = '0034_ai_configuration.sql';
PRAGMA foreign_key_check;
