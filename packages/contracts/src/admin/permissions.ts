// packages/contracts/src/admin/permissions.ts — CAP-017 / CAP-067.
//
// The permission vocabulary is intentionally closed. Adding a key is a
// deliberate authorization change and must update the seed data, route gates,
// and the contract tests together.

import { z } from 'zod';

export const permissionKeySchema = z.enum([
  'message.read',
  'message.send',
  'message.delete',
  'mailbox.create',
  'mailbox.manage',
  'mailbox.share',
  'user.read',
  'user.manage',
  'role.read',
  'role.manage',
  'domain.read',
  'domain.manage',
  'signature.read',
  'signature.manage',
  'settings.read',
  'settings.manage',
  'provider.sync',
  'webhook_event.read',
  'webhook_event.delete',
  'analytics.read',
  'audit.read',
]);

export type PermissionKey = z.infer<typeof permissionKeySchema>;
