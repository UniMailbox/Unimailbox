// settings-administration-service — CAP-069.
//
// This is the application boundary for the global system-settings resource.
// It owns the atomic D1 batch containing setting values, idempotency evidence,
// and the audit event; HTTP only handles transport and permissions.

import {
  systemSettingsResponseSchema,
  updateSystemSettingsRequestSchema,
  type SystemSettingsResponse,
  type UpdateSystemSettingsRequest,
} from '@unimailbox/contracts';
import type { Clock } from '../../platform/clock';
import { systemClock } from '../../platform/clock';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  isIdempotencyUniqueViolation,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
} from '../../platform/idempotency';
import type { IdGenerator } from '../../platform/ids';
import { systemIds } from '../../platform/ids';
import { prepareCreateAuditEvent } from './audit-event-repository';
import {
  prepareCompareAndSetSettingsRevision,
  prepareUpsertSystemSettings,
  readSystemSettings,
  type SystemSettingsSnapshot,
} from './settings-repository';

const UPDATE_OPERATION = 'PATCH /api/v1/admin/settings';

export interface SettingsAdministrationServiceDependencies {
  readonly db: Database;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface ReadAdminSystemSettingsInput {
  readonly environment: string;
  readonly canManage: boolean;
}

export interface UpdateAdminSystemSettingsInput {
  readonly actorUserId: string;
  readonly request: UpdateSystemSettingsRequest;
  readonly expectedUpdatedAt: string;
  readonly environment: string;
  readonly canManage: boolean;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface SettingsAdministrationServiceResult {
  readonly status: 200;
  readonly responseJson: string;
  readonly replayed: boolean;
}

export async function getAdminSystemSettings(
  db: Database,
  input: ReadAdminSystemSettingsInput,
): Promise<SystemSettingsResponse> {
  const snapshot = await readSystemSettings(db);
  return toResponse(snapshot, input.environment, input.canManage, snapshot.updatedAt);
}

export async function updateAdminSystemSettings(
  dependencies: SettingsAdministrationServiceDependencies,
  input: UpdateAdminSystemSettingsInput,
): Promise<SettingsAdministrationServiceResult> {
  const request = updateSystemSettingsRequestSchema.parse(input.request);
  const replay = await replayIfPresent(
    dependencies.db,
    input.actorUserId,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const current = await readSystemSettings(dependencies.db);
  if (current.updatedAt !== input.expectedUpdatedAt) {
    const replay = await replayIfPresent(
      dependencies.db,
      input.actorUserId,
      input.idempotencyKey,
      input.requestHash,
    );
    if (replay) return replay;
    throw new DomainError({
      code: 'STALE_IF_MATCH',
      message: 'Settings changed since they were loaded',
      httpStatus: 412,
    });
  }
  const changedKeys = (Object.keys(request) as Array<keyof UpdateSystemSettingsRequest>).filter(
    (key) => current.settings[key] !== request[key],
  );
  const updatedAt = nextSettingsTimestamp(clock, current.updatedAt);
  const response = toResponse(current, input.environment, input.canManage, updatedAt, request);
  const responseJson = JSON.stringify({ data: response });

  try {
    await dependencies.db.batch([
      prepareCreateIdempotencyRecord(dependencies.db, {
        id: ids.uuid(),
        actorId: input.actorUserId,
        operation: UPDATE_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 200,
        responseJson,
        createdAt: updatedAt,
      }),
      prepareCompareAndSetSettingsRevision(dependencies.db, input.expectedUpdatedAt, updatedAt),
      ...prepareUpsertSystemSettings(dependencies.db, request, updatedAt),
      prepareCreateAuditEvent(dependencies.db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'settings.updated',
        resourceType: 'system_settings',
        resourceId: 'system',
        requestId: input.requestId,
        metadata: JSON.stringify({ changedKeys }),
        createdAt: updatedAt,
      }),
    ]);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      return replayAfterRace(
        dependencies.db,
        input.actorUserId,
        input.idempotencyKey,
        input.requestHash,
      );
    }
    if (isSettingsRevisionConflict(error)) {
      const replay = await replayIfPresent(
        dependencies.db,
        input.actorUserId,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) return replay;
      throw new DomainError({
        code: 'STALE_IF_MATCH',
        message: 'Settings changed while this update was being saved',
        httpStatus: 412,
        cause: error,
      });
    }
    throw error;
  }

  return { status: 200, responseJson, replayed: false };
}

function nextSettingsTimestamp(clock: Clock, currentUpdatedAt: string): string {
  const candidate = sqliteTimestamp(clock.now());
  const currentMillis = Date.parse(`${currentUpdatedAt.replace(' ', 'T')}Z`);
  const candidateMillis = Date.parse(`${candidate.replace(' ', 'T')}Z`);
  if (Number.isFinite(currentMillis) && candidateMillis <= currentMillis) {
    return sqliteTimestamp(new Date(currentMillis + 1000));
  }
  return candidate;
}

function isSettingsRevisionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('NOT NULL constraint failed: system_settings.value')
  );
}

function toResponse(
  snapshot: SystemSettingsSnapshot,
  environment: string,
  canManage: boolean,
  updatedAt: string,
  settings = snapshot.settings,
): SystemSettingsResponse {
  return systemSettingsResponseSchema.parse({ settings, environment, canManage, updatedAt });
}

async function replayIfPresent(
  db: Database,
  actorUserId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<SettingsAdministrationServiceResult | null> {
  const record = await findIdempotencyRecord(db, actorUserId, UPDATE_OPERATION, idempotencyKey);
  if (!record) return null;
  assertSameRequestHash(record, requestHash);
  return { status: 200, responseJson: record.responseJson, replayed: true };
}

async function replayAfterRace(
  db: Database,
  actorUserId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<SettingsAdministrationServiceResult> {
  const replay = await replayIfPresent(db, actorUserId, idempotencyKey, requestHash);
  if (replay) return replay;
  throw new Error('Concurrent settings request did not leave idempotency evidence');
}
