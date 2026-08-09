-- Expand-and-contract migration. Add reviewed SQL below.
PRAGMA foreign_keys = ON;

-- MVP cut: drop the 22-key seed from 0002_seed_permissions.sql down to the
-- five permission keys the M1 administrator actually carries. The member role
-- is also removed; it is restored in M2 by issue #23 (0011_resume_shared_
-- mailboxes.sql).
--
-- Companion work: see admin role grant trimming in
-- packages/contracts/src/domain/index.ts (PR #31, issue #15).

DELETE FROM role_permissions
WHERE permission_key NOT IN (
  'message.read',
  'message.send',
  'mailbox.create',
  'settings.read',
  'settings.manage'
);

DELETE FROM role_permissions
WHERE role_id = '00000000-0000-4000-8000-000000000002';

DELETE FROM permissions
WHERE key NOT IN (
  'message.read',
  'message.send',
  'mailbox.create',
  'settings.read',
  'settings.manage'
);

DELETE FROM roles WHERE name = 'member';

INSERT OR IGNORE INTO permissions (key, description) VALUES
  ('message.read',   'Read messages in an authorized mailbox'),
  ('message.send',   'Send messages from an authorized mailbox'),
  ('mailbox.create', 'Create a mailbox on a managed domain'),
  ('settings.read',  'View system settings'),
  ('settings.manage','Manage system settings');

INSERT OR IGNORE INTO roles (id, name, description, is_system) VALUES
  ('00000000-0000-4000-8000-000000000001', 'administrator',
   'Full installation administration', 1);

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT '00000000-0000-4000-8000-000000000001', key FROM permissions;
