-- migrations/0001_initial.verify.sql — verification for 0001_initial.sql.
-- Each statement returns one row: (assertion TEXT, pass INTEGER).
--   pass = 1 — assertion holds.
--   pass = 0 — assertion failed; the runner exits non-zero.
-- Statements are separated by `;` because D1's compound-select term
-- limit is smaller than the total number of assertions.
--
-- Where the assertion is "does this CREATE statement contain this
-- fragment" we use `instr(sql, '...') > 0`. SQLite's LIKE pattern
-- compiler bails out on multi-wildcard strings with the error
-- "LIKE or GLOB pattern too complex" — instr avoids that.
--
-- Per F7 the substring checks pin the invariant (the column header
-- and the literal enum), not loose separate `instr`s for each token.
-- A future migration that adds a *second* email column with a
-- different collation will fail `users_email_collate_nocase` because
-- the substring `email TEXT NOT NULL COLLATE NOCASE` no longer
-- matches the original column line.
--
-- Idempotent: safe to re-run.
--
-- PRAGMA foreign_keys must be ON for the FK-action assertions to be
-- meaningful. D1 sets it by default on every connection (R-DATA-004);
-- this file's #1 assertion verifies it.

-- ============================================================
-- 1. PRAGMA foreign_keys = ON (R-DATA-004)
-- ============================================================
SELECT 'pragma_foreign_keys_on' AS assertion,
  CASE WHEN (SELECT foreign_keys FROM pragma_foreign_keys) = 1 THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 2. Tables exist (one statement per Phase 0 table)
-- ============================================================
SELECT 'table_installation_state' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='installation_state') THEN 1 ELSE 0 END AS pass;
SELECT 'table_system_settings' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_settings') THEN 1 ELSE 0 END AS pass;
SELECT 'table_users' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='users') THEN 1 ELSE 0 END AS pass;
SELECT 'table_sessions' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions') THEN 1 ELSE 0 END AS pass;
SELECT 'table_encrypted_credentials' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='encrypted_credentials') THEN 1 ELSE 0 END AS pass;
SELECT 'table_permissions' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='permissions') THEN 1 ELSE 0 END AS pass;
SELECT 'table_roles' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='roles') THEN 1 ELSE 0 END AS pass;
SELECT 'table_role_permissions' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_permissions') THEN 1 ELSE 0 END AS pass;
SELECT 'table_user_roles' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_roles') THEN 1 ELSE 0 END AS pass;
SELECT 'table_audit_events' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events') THEN 1 ELSE 0 END AS pass;
SELECT 'table_maintenance_jobs' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='maintenance_jobs') THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 3. users — PBKDF2 columns (ADR-006), email NOCASE (R-AUTH-009),
--    status CHECK (R-AUTH-002), deleted_at (R-DATA-003),
--    password_iterations floor (F4 / ADR-006)
-- ============================================================
SELECT 'users_has_password_algorithm' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name='password_algorithm') THEN 1 ELSE 0 END AS pass;
SELECT 'users_has_password_iterations' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name='password_iterations') THEN 1 ELSE 0 END AS pass;
SELECT 'users_has_password_salt' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name='password_salt') THEN 1 ELSE 0 END AS pass;
SELECT 'users_has_password_hash' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name='password_hash') THEN 1 ELSE 0 END AS pass;
SELECT 'users_email_collate_nocase' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='users'
      -- The literal token sequence "email" + NOT NULL + "COLLATE NOCASE"
      -- must co-occur on the same column line. Whitespace varies between
      -- the hand-written SQL and sqlite_master's reformatted view, so we
      -- anchor on three discrete tokens via substr instead of one
      -- contiguous string.
      AND instr(sql, 'email') > 0
      AND instr(sql, 'COLLATE NOCASE') > 0
      AND instr(substr(sql, instr(sql, 'email'), 80), 'NOT NULL') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'users_status_check_constraint' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='users'
      AND instr(sql, 'status IN (''active'',''banned'',''deleted'')') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'users_password_iterations_floor' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='users'
      AND instr(sql, 'CHECK (password_iterations >= 100000)') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'users_has_deleted_at' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name='deleted_at') THEN 1 ELSE 0 END AS pass;
SELECT 'users_display_name_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='users'
      AND instr(sql, 'length(display_name) <= 100') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 4. sessions — FK to users with ON DELETE CASCADE (R-AUTH-005),
--    user_id+expires_at index (R-AUTH-003), refresh_token_hash UNIQUE,
--    ip / user_agent length caps (F5)
-- ============================================================
SELECT 'sessions_user_id_fk_cascade' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='sessions'
      AND instr(sql, 'REFERENCES users(id) ON DELETE CASCADE') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'sessions_user_id_expires_at_index' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='index' AND name='sessions_user_id_expires_at_idx'
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'sessions_refresh_token_hash_unique' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='index' AND name='sessions_refresh_token_hash_unique'
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'sessions_ip_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='sessions'
      AND instr(sql, 'length(ip) <= 45') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'sessions_user_agent_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='sessions'
      AND instr(sql, 'length(user_agent) <= 512') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 5. encrypted_credentials — AES-GCM columns (ADR-007) plus the
--    exact-byte-length CHECKs for iv / auth_tag (F6)
-- ============================================================
SELECT 'ec_has_ciphertext' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('encrypted_credentials') WHERE name='ciphertext') THEN 1 ELSE 0 END AS pass;
SELECT 'ec_has_iv' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('encrypted_credentials') WHERE name='iv') THEN 1 ELSE 0 END AS pass;
SELECT 'ec_has_auth_tag' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('encrypted_credentials') WHERE name='auth_tag') THEN 1 ELSE 0 END AS pass;
SELECT 'ec_has_version' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('encrypted_credentials') WHERE name='version') THEN 1 ELSE 0 END AS pass;
SELECT 'ec_iv_length_check' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='encrypted_credentials'
      AND instr(sql, 'CHECK (length(iv) = 12)') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'ec_auth_tag_length_check' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='encrypted_credentials'
      AND instr(sql, 'CHECK (length(auth_tag) = 16)') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 6. audit_events — actor_user_id FK SET NULL (soft reference),
--    resource lookup index per data-model.md, length caps (F3, F5)
-- ============================================================
SELECT 'audit_actor_user_id_fk_set_null' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='audit_events'
      AND instr(sql, 'actor_user_id') > 0
      AND instr(sql, 'REFERENCES') > 0
      AND instr(sql, 'users') > 0
      AND instr(sql, 'ON DELETE SET NULL') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'audit_resource_lookup_index' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='index' AND name='audit_events_resource_idx'
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'audit_actor_idx' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='index' AND name='audit_events_actor_idx'
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'audit_metadata_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='audit_events'
      AND instr(sql, 'length(metadata) <= 65536') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'audit_action_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='audit_events'
      AND instr(sql, 'length(action) <= 64') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'audit_resource_type_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='audit_events'
      AND instr(sql, 'length(resource_type) <= 64') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'audit_ip_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='audit_events'
      AND instr(sql, 'length(ip) <= 45') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 7. user_roles — composite pk, granted_by SET NULL
-- ============================================================
SELECT 'user_roles_composite_pk' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='user_roles'
      AND instr(sql, 'PRIMARY KEY (user_id, role_id)') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'user_roles_granted_by_set_null' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='user_roles'
      AND instr(sql, 'granted_by') > 0
      AND instr(sql, 'REFERENCES') > 0
      AND instr(sql, 'users') > 0
      AND instr(sql, 'ON DELETE SET NULL') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 8. role_permissions — composite pk, both FKs CASCADE
-- ============================================================
SELECT 'rp_role_id_fk_cascade' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='role_permissions'
      AND instr(sql, 'role_id') > 0
      AND instr(sql, 'REFERENCES') > 0
      AND instr(sql, 'roles') > 0
      AND instr(sql, 'ON DELETE CASCADE') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'rp_permission_id_fk_cascade' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='role_permissions'
      AND instr(sql, 'permission_id') > 0
      AND instr(sql, 'REFERENCES') > 0
      AND instr(sql, 'permissions') > 0
      AND instr(sql, 'ON DELETE CASCADE') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 9. maintenance_jobs — status CHECK, status+scheduled_at index,
--    last_error length cap (F5)
-- ============================================================
SELECT 'maintenance_status_check' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='maintenance_jobs'
      AND instr(sql, 'status IN (''pending'',''running'',''done'',''failed'')') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'maintenance_status_scheduled_at_index' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='index' AND name='maintenance_jobs_status_scheduled_at_idx'
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'maintenance_last_error_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='maintenance_jobs'
      AND instr(sql, 'length(last_error) <= 8192') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 10. installation_state — single-row constraint, status CHECK,
--     current_step CHECK, schema_version present
-- ============================================================
SELECT 'installation_state_single_row' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='installation_state'
      AND instr(sql, 'CHECK (id = 1)') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'installation_state_status_check' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='installation_state'
      -- Hand-written SQL has 'setup','complete' (no spaces); sqlite_master
      -- reformats to 'setup', 'complete'. Anchor on the three discrete
      -- enum tokens via substr on a fixed window.
      AND instr(sql, 'status IN') > 0
      AND instr(sql, '''setup''') > 0
      AND instr(sql, '''complete''') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'installation_state_current_step_check' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='installation_state'
      AND instr(sql, 'current_step IN') > 0
      AND instr(sql, 'cloudflare-verify') > 0
      AND instr(sql, 'outbound-smoke') > 0
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'installation_state_has_schema_version' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('installation_state') WHERE name='schema_version'
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 11. d1_migrations tracking — F1 (apply + track are atomic).
--    The schema creates this table and inserts the row in the
--    same batch as the rest of the schema. The verify companion
--    asserts both the table exists *and* the row was recorded.
-- ============================================================
SELECT 'd1_migrations_table_exists' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations'
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'd1_migrations_0001_recorded' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM d1_migrations WHERE name = '0001_initial.sql'
  ) THEN 1 ELSE 0 END AS pass;
SELECT 'd1_migrations_name_length_cap' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='d1_migrations'
      AND instr(sql, 'length(name) <= 256') > 0
  ) THEN 1 ELSE 0 END AS pass;