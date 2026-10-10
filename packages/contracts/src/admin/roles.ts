// packages/contracts/src/admin/roles.ts — CAP-067 role administration.
//
// The role API exposes only role metadata and permission keys. Storage-only
// columns such as user assignments never cross this contract boundary.

import { z } from 'zod';
import { permissionKeySchema, type PermissionKey } from './permissions';

export const roleNameSchema = z.string().trim().min(1).max(100);
export const roleDescriptionSchema = z.string().trim().min(1).max(500);

function uniquePermissionKeys(keys: ReadonlyArray<string>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  keys.forEach((key, index) => {
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: 'duplicate permission key',
      });
      return;
    }
    seen.add(key);
  });
}

export const rolePermissionKeysSchema = z
  .array(permissionKeySchema)
  .max(21)
  .superRefine(uniquePermissionKeys);

export type RolePermissionKeys = z.infer<typeof rolePermissionKeysSchema>;

export const createRoleRequestSchema = z
  .object({
    name: roleNameSchema,
    description: roleDescriptionSchema,
    permissionKeys: rolePermissionKeysSchema,
  })
  .strict();

export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = createRoleRequestSchema;

export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

export const rolePermissionSchema = z
  .object({
    key: permissionKeySchema,
    description: z.string().trim().min(1).max(500),
  })
  .strict();

export type RolePermission = z.infer<typeof rolePermissionSchema>;

export const permissionCatalogSchema = z
  .array(rolePermissionSchema)
  .superRefine((permissions, ctx) => {
    if (permissions.length !== permissionKeySchema.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'permission catalog must contain every declared permission exactly once',
      });
    }
    const seen = new Set<PermissionKey>();
    for (const [index, permission] of permissions.entries()) {
      if (seen.has(permission.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'key'],
          message: 'duplicate permission key',
        });
      }
      seen.add(permission.key);
    }
    for (const key of permissionKeySchema.options) {
      if (!seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing permission key: ${key}`,
        });
      }
    }
  });

export type PermissionCatalog = z.infer<typeof permissionCatalogSchema>;

export const roleSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: roleNameSchema,
    description: roleDescriptionSchema,
    isSystem: z.boolean(),
    permissionKeys: rolePermissionKeysSchema,
  })
  .strict();

export type Role = z.infer<typeof roleSchema>;

export const permissionCatalogResponseSchema = z
  .object({
    permissions: permissionCatalogSchema,
  })
  .strict();

export type PermissionCatalogResponse = z.infer<typeof permissionCatalogResponseSchema>;

export const roleListResponseSchema = z
  .object({
    roles: z.array(roleSchema),
    permissions: permissionCatalogSchema,
  })
  .strict();

export type RoleListResponse = z.infer<typeof roleListResponseSchema>;

export const roleMutationResponseSchema = z
  .object({
    data: roleSchema,
  })
  .strict();

export const deleteRoleResponseSchema = z
  .object({
    id: z.string().min(1).max(128),
    deleted: z.literal(true),
  })
  .strict();

export type DeleteRoleResponse = z.infer<typeof deleteRoleResponseSchema>;
