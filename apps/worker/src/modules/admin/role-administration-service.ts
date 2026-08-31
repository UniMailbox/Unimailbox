// role-administration-service — CAP-067.
//
// The admin module owns roles, permissions, role_permissions, and user_roles.
// This service is the application boundary for the role-definition workflow;
// HTTP routes only validate transport input and map the response.

import {
  rolePermissionSchema,
  roleSchema,
  type PermissionKey,
  type Role,
  type RolePermission,
  type RoleListResponse,
} from '@unimailbox/contracts';
import type { Clock } from '../../platform/clock';
import { systemClock } from '../../platform/clock';
import type { Database } from '../../platform/database';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  isIdempotencyUniqueViolation,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
} from '../../platform/idempotency';
import type { IdGenerator } from '../../platform/ids';
import { systemIds } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import { prepareCreateAuditEvent } from './audit-event-repository';

const CREATE_OPERATION = 'POST /api/v1/admin/roles';

export interface RoleAdministrationServiceDependencies {
  readonly db: Database;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface CreateAdminRoleInput {
  readonly actorUserId: string;
  readonly name: string;
  readonly description: string;
  readonly permissionKeys: ReadonlyArray<PermissionKey>;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface UpdateAdminRoleInput extends CreateAdminRoleInput {
  readonly roleId: string;
}

export interface DeleteAdminRoleInput {
  readonly actorUserId: string;
  readonly roleId: string;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface RoleAdministrationServiceResult {
  readonly status: 200 | 201;
  readonly responseJson: string;
  readonly replayed: boolean;
}

interface RoleStorageRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly is_system: number;
}

interface RolePermissionStorageRow extends RoleStorageRow {
  readonly permission_key: string | null;
}

interface PermissionStorageRow {
  readonly key: string;
  readonly description: string;
}

/** Returns the safe role list plus the complete permission catalog. */
export async function listAdminRoles(db: Database): Promise<RoleListResponse> {
  const [roleRows, permissionRows] = await Promise.all([
    db
      .prepare(
        `SELECT r.id, r.name, r.description, r.is_system, p.key AS permission_key
           FROM roles r
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
           LEFT JOIN permissions p ON p.id = rp.permission_id
          ORDER BY r.is_system DESC, r.name COLLATE NOCASE ASC, p.key ASC`,
      )
      .all<RolePermissionStorageRow>(),
    db
      .prepare('SELECT key, description FROM permissions ORDER BY key ASC')
      .all<PermissionStorageRow>(),
  ]);

  const roles = hydrateRoles(roleRows.results ?? []);
  const permissions = (permissionRows.results ?? []).map((row) => parseStoredPermission(row));
  return { roles, permissions };
}

/** Creates a custom role and its permissions in one audited D1 batch. */
export async function createAdminRole(
  dependencies: RoleAdministrationServiceDependencies,
  input: CreateAdminRoleInput,
): Promise<RoleAdministrationServiceResult> {
  const db = dependencies.db;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    CREATE_OPERATION,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const permissionKeys = canonicalPermissionKeys(input.permissionKeys);
  const permissions = await loadPermissions(db, permissionKeys);
  const id = ids.uuid();
  const now = sqliteTimestamp(clock.now());
  const role: Role = {
    id,
    name: input.name,
    description: input.description,
    isSystem: false,
    permissionKeys,
  };
  const responseJson = JSON.stringify({ data: role });

  try {
    await db.batch([
      prepareCreateIdempotencyRecord(db, {
        id: ids.uuid(),
        actorId: input.actorUserId,
        operation: CREATE_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 201,
        responseJson,
        createdAt: now,
      }),
      db
        .prepare(
          `INSERT INTO roles (id, name, description, is_system, created_at)
           VALUES (?, ?, ?, 0, ?)`,
        )
        .bind(id, role.name, role.description, now),
      ...preparePermissionInserts(db, id, permissions, now),
      prepareCreateAuditEvent(db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'role.created',
        resourceType: 'role',
        resourceId: id,
        requestId: input.requestId,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      return replayAfterRace(
        db,
        input.actorUserId,
        CREATE_OPERATION,
        input.idempotencyKey,
        input.requestHash,
      );
    }
    throw mapRoleWriteError(error);
  }

  return { status: 201, responseJson, replayed: false };
}

/** Replaces a custom role definition and permission relation atomically. */
export async function updateAdminRole(
  dependencies: RoleAdministrationServiceDependencies,
  input: UpdateAdminRoleInput,
): Promise<RoleAdministrationServiceResult> {
  const db = dependencies.db;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const operation = updateOperation(input.roleId);
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const current = await findRole(db, input.roleId);
  assertCustomRole(current, input.roleId);
  const permissionKeys = canonicalPermissionKeys(input.permissionKeys);
  const permissions = await loadPermissions(db, permissionKeys);
  const now = sqliteTimestamp(clock.now());
  const role: Role = {
    id: current.id,
    name: input.name,
    description: input.description,
    isSystem: false,
    permissionKeys,
  };
  const responseJson = JSON.stringify({ data: role });

  try {
    await db.batch([
      prepareCreateIdempotencyRecord(db, {
        id: ids.uuid(),
        actorId: input.actorUserId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 200,
        responseJson,
        createdAt: now,
      }),
      db
        .prepare(
          `UPDATE roles
              SET name = ?, description = ?
            WHERE id = ? AND is_system = 0`,
        )
        .bind(role.name, role.description, role.id),
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(role.id),
      ...preparePermissionInserts(db, role.id, permissions, now),
      prepareRequireRolePresent(db, role.id),
      prepareCreateAuditEvent(db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'role.updated',
        resourceType: 'role',
        resourceId: role.id,
        requestId: input.requestId,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      return replayAfterRace(
        db,
        input.actorUserId,
        operation,
        input.idempotencyKey,
        input.requestHash,
      );
    }
    if (isRolePresenceGuardFailure(error)) {
      const latest = await findRole(db, input.roleId);
      assertCustomRole(latest, input.roleId, error);
    }
    throw mapRoleWriteError(error);
  }

  return { status: 200, responseJson, replayed: false };
}

/** Deletes an unassigned custom role and its permission relation atomically. */
export async function deleteAdminRole(
  dependencies: RoleAdministrationServiceDependencies,
  input: DeleteAdminRoleInput,
): Promise<RoleAdministrationServiceResult> {
  const db = dependencies.db;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const operation = deleteOperation(input.roleId);
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const current = await findRole(db, input.roleId);
  assertCustomRole(current, input.roleId);
  if (await hasAssignedUsers(db, input.roleId)) {
    throw new DomainError({
      code: 'ROLE_IN_USE',
      message: 'Role is assigned to one or more users',
      httpStatus: 409,
    });
  }

  const responseJson = JSON.stringify({ data: { id: input.roleId, deleted: true } });
  const now = sqliteTimestamp(clock.now());
  try {
    await db.batch([
      prepareCreateIdempotencyRecord(db, {
        id: ids.uuid(),
        actorId: input.actorUserId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 200,
        responseJson,
        createdAt: now,
      }),
      db
        .prepare(
          `DELETE FROM roles
             WHERE id = ? AND is_system = 0
               AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role_id = ?)`,
        )
        .bind(input.roleId, input.roleId),
      prepareRequireRoleDeleted(db),
      prepareCreateAuditEvent(db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'role.deleted',
        resourceType: 'role',
        resourceId: input.roleId,
        requestId: input.requestId,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      return replayAfterRace(
        db,
        input.actorUserId,
        operation,
        input.idempotencyKey,
        input.requestHash,
      );
    }
    if (isRolePresenceGuardFailure(error)) {
      const latest = await findRole(db, input.roleId);
      if (latest === null) throw roleNotFound(input.roleId, error);
      if (latest.is_system === 1) throw systemRoleProtected(input.roleId, error);
      if (await hasAssignedUsers(db, input.roleId)) {
        throw roleInUse(error);
      }
    }
    throw mapRoleWriteError(error);
  }

  return { status: 200, responseJson, replayed: false };
}

async function findRole(db: Database, roleId: string): Promise<RoleStorageRow | null> {
  return db
    .prepare('SELECT id, name, description, is_system FROM roles WHERE id = ? LIMIT 1')
    .bind(roleId)
    .first<RoleStorageRow>();
}

async function loadPermissions(
  db: Database,
  keys: ReadonlyArray<PermissionKey>,
): Promise<ReadonlyArray<RolePermission>> {
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => '?').join(', ');
  const rows = await db
    .prepare(`SELECT key, description FROM permissions WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<PermissionStorageRow>();
  const permissions = (rows.results ?? []).map((row) => parseStoredPermission(row));
  const byKey = new Map(permissions.map((permission) => [permission.key, permission]));
  const missing = keys.find((key) => !byKey.has(key));
  if (missing !== undefined) {
    throw new DomainError({
      code: 'ROLE_PERMISSION_NOT_FOUND',
      message: `Permission is not available: ${missing}`,
      httpStatus: 400,
    });
  }
  return keys.map((key) => {
    const permission = byKey.get(key);
    if (permission === undefined) {
      throw new DomainError({
        code: 'ROLE_PERMISSION_NOT_FOUND',
        message: `Permission is not available: ${key}`,
        httpStatus: 400,
      });
    }
    return permission;
  });
}

function preparePermissionInserts(
  db: Database,
  roleId: string,
  permissions: ReadonlyArray<RolePermission>,
  createdAt: string,
): D1PreparedStatement[] {
  return permissions.map((permission) =>
    db
      .prepare(
        `INSERT INTO role_permissions (role_id, permission_id, created_at)
         SELECT ?, id, ? FROM permissions WHERE key = ?`,
      )
      .bind(roleId, createdAt, permission.key),
  );
}

function hydrateRoles(rows: ReadonlyArray<RolePermissionStorageRow>): Role[] {
  const roles = new Map<string, { row: RoleStorageRow; permissionKeys: string[] }>();
  for (const row of rows) {
    let entry = roles.get(row.id);
    if (entry === undefined) {
      entry = {
        row: {
          id: row.id,
          name: row.name,
          description: row.description,
          is_system: row.is_system,
        },
        permissionKeys: [],
      };
      roles.set(row.id, entry);
    }
    if (row.permission_key !== null) {
      entry.permissionKeys.push(row.permission_key);
    }
  }
  return [...roles.values()].map((entry) => {
    const permissionKeys = entry.permissionKeys.sort();
    const parsed = roleSchema.safeParse({
      id: entry.row.id,
      name: entry.row.name,
      description: entry.row.description,
      isSystem: entry.row.is_system === 1,
      permissionKeys,
    });
    if (!parsed.success) {
      throw new DomainError({
        code: 'INTERNAL',
        message: 'Stored role data failed validation',
        httpStatus: 500,
        cause: parsed.error,
      });
    }
    return parsed.data;
  });
}

function parseStoredPermission(row: PermissionStorageRow): RolePermission {
  const parsed = rolePermissionSchema.safeParse(row);
  if (!parsed.success) {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'Stored permission data failed validation',
      httpStatus: 500,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function canonicalPermissionKeys(keys: ReadonlyArray<PermissionKey>): PermissionKey[] {
  return [...keys].sort();
}

function assertCustomRole(
  role: RoleStorageRow | null,
  roleId: string,
  cause?: unknown,
): asserts role is RoleStorageRow {
  if (role === null) throw roleNotFound(roleId, cause);
  if (role.is_system === 1) throw systemRoleProtected(roleId, cause);
}

function roleNotFound(roleId: string, cause?: unknown): DomainError {
  return new DomainError({
    code: 'ROLE_NOT_FOUND',
    message: `Role not found: ${roleId}`,
    httpStatus: 404,
    ...(cause === undefined ? {} : { cause }),
  });
}

function systemRoleProtected(roleId: string, cause?: unknown): DomainError {
  return new DomainError({
    code: 'SYSTEM_ROLE_PROTECTED',
    message: `System role cannot be changed: ${roleId}`,
    httpStatus: 409,
    ...(cause === undefined ? {} : { cause }),
  });
}

function roleInUse(cause?: unknown): DomainError {
  return new DomainError({
    code: 'ROLE_IN_USE',
    message: 'Role is assigned to one or more users',
    httpStatus: 409,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function hasAssignedUsers(db: Database, roleId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS present FROM user_roles WHERE role_id = ? LIMIT 1')
    .bind(roleId)
    .first<{ present: number }>();
  return row !== null;
}

function prepareRequireRolePresent(db: Database, roleId: string): D1PreparedStatement {
  // `administrator` is a protected seeded role, so inserting the same
  // primary key is a deterministic batch failure when the target vanished.
  return db
    .prepare(
      `INSERT INTO roles (id, name, description, is_system, created_at)
       SELECT 'administrator', 'administrator', 'Full system access', 1, datetime('now')
        WHERE NOT EXISTS (SELECT 1 FROM roles WHERE id = ? AND is_system = 0)`,
    )
    .bind(roleId);
}

function prepareRequireRoleDeleted(db: Database): D1PreparedStatement {
  // The same protected primary key gives a reliable failure even when the
  // deleted role was the only custom row and SQLite changes() is zero.
  return db.prepare(
    `INSERT INTO roles (id, name, description, is_system, created_at)
     SELECT 'administrator', 'administrator', 'Full system access', 1, datetime('now')
      WHERE changes() = 0`,
  );
}

async function replayIfPresent(
  db: Database,
  actorUserId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<RoleAdministrationServiceResult | null> {
  const record = await findIdempotencyRecord(db, actorUserId, operation, idempotencyKey);
  if (!record) return null;
  assertSameRequestHash(record, requestHash);
  return {
    status: record.responseStatus === 201 ? 201 : 200,
    responseJson: record.responseJson,
    replayed: true,
  };
}

async function replayAfterRace(
  db: Database,
  actorUserId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<RoleAdministrationServiceResult> {
  const replay = await replayIfPresent(db, actorUserId, operation, idempotencyKey, requestHash);
  if (replay) return replay;
  throw new DomainError({
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Concurrent request with the same Idempotency-Key is in flight',
    httpStatus: 409,
  });
}

function updateOperation(roleId: string): string {
  return `PATCH /api/v1/admin/roles/${roleId}`;
}

function deleteOperation(roleId: string): string {
  return `DELETE /api/v1/admin/roles/${roleId}`;
}

function isRolePresenceGuardFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed: roles');
}

function mapRoleWriteError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed: roles.name')) {
    return new DomainError({
      code: 'ROLE_NAME_TAKEN',
      message: 'A role with this name already exists',
      httpStatus: 409,
      cause: error,
    });
  }
  return new DomainError({
    code: 'INTERNAL',
    message: 'Unable to manage role',
    httpStatus: 500,
    cause: error,
  });
}
