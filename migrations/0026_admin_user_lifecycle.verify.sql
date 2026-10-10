-- CAP-A1 migration verification
SELECT 'must_change_password_column' AS assertion,
       EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name = 'must_change_password') AS pass;
SELECT 'initial_password_expires_at_column' AS assertion,
       EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name = 'initial_password_expires_at') AS pass;
SELECT 'initial_password_expiry_index' AS assertion,
       EXISTS (SELECT 1 FROM pragma_index_list('users') WHERE name = 'users_initial_password_expiry_idx') AS pass;
SELECT '0026_tracking_row_exists' AS assertion,
       COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0026_admin_user_lifecycle.sql';
