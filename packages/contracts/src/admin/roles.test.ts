import { describe, expect, it } from 'vitest';
import {
  createRoleRequestSchema,
  permissionCatalogResponseSchema,
  roleListResponseSchema,
  roleSchema,
  updateRoleRequestSchema,
} from './roles';
import { permissionKeySchema } from './permissions';

const ROLE_ID = '00000000-0000-4000-8000-000000000001';

const role = {
  id: ROLE_ID,
  name: 'Support agent',
  description: 'Can read and send messages',
  isSystem: false,
  permissionKeys: ['message.read', 'message.send'],
};

const permissions = permissionKeySchema.options.map((key) => ({
  key,
  description: `Description for ${key}`,
}));

describe('role contracts (CAP-067)', () => {
  it('normalizes create and update requests and rejects duplicate permissions', () => {
    expect(
      createRoleRequestSchema.parse({
        name: '  Support agent  ',
        description: '  Can read and send messages  ',
        permissionKeys: ['message.read', 'message.send'],
      }),
    ).toEqual({
      name: 'Support agent',
      description: 'Can read and send messages',
      permissionKeys: ['message.read', 'message.send'],
    });
    expect(
      updateRoleRequestSchema.safeParse({
        name: 'Support agent',
        description: 'Description',
        permissionKeys: ['message.read', 'message.read'],
      }).success,
    ).toBe(false);
    expect(
      createRoleRequestSchema.safeParse({
        name: 'Support agent',
        description: 'Description',
        permissionKeys: ['not-a-permission'],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty permission set and rejects unknown request fields', () => {
    expect(
      createRoleRequestSchema.parse({
        name: '  Empty role ',
        description: ' No grants yet ',
        permissionKeys: [],
      }),
    ).toEqual({ name: 'Empty role', description: 'No grants yet', permissionKeys: [] });
    expect(
      createRoleRequestSchema.safeParse({
        name: 'Support agent',
        description: 'Description',
        permissionKeys: [],
        isSystem: true,
      }).success,
    ).toBe(false);
  });

  it('keeps role and permission list responses strict', () => {
    expect(roleSchema.parse(role)).toEqual(role);
    expect(roleSchema.safeParse({ ...role, secret: 'must not cross the boundary' }).success).toBe(
      false,
    );
    expect(
      roleListResponseSchema.parse({
        roles: [role],
        permissions,
      }),
    ).toEqual({
      roles: [role],
      permissions,
    });
    expect(
      permissionCatalogResponseSchema.safeParse({
        permissions: [
          ...permissions.slice(0, -1),
          { key: 'message.read', description: 'Read messages', id: 'secret' },
        ],
      }).success,
    ).toBe(false);
    expect(
      permissionCatalogResponseSchema.safeParse({ permissions: permissions.slice(0, -1) }).success,
    ).toBe(false);
    expect(
      permissionCatalogResponseSchema.safeParse({ permissions: [...permissions, permissions[0]] })
        .success,
    ).toBe(false);
  });
});
