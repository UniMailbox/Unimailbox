// domain-administration-service — CAP-066 managed-domain use cases.
//
// Administration owns the operator-facing workflow. It composes the public
// tenancy repository with the admin audit seam and the platform idempotency
// helpers, so HTTP routes only handle transport/authentication concerns.

import type { ManagedDomain } from '@unimailbox/contracts';
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
import {
  countMailboxesForDomain,
  findManagedDomainById,
  listManagedDomains,
  prepareCreateDomain,
  prepareDeleteDomain,
  prepareRequireManagedDomainDeleted,
  prepareRequireManagedDomainUpdated,
  prepareUpdateDomainOutboundConnection,
  type ManagedDomainInfo,
} from '../tenancy';
import { findProviderConnectionForBinding } from '../outbound-mail';

const CREATE_OPERATION = 'POST /api/v1/admin/domains';

export interface AdminDomainServiceDependencies {
  readonly db: Database;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface CreateAdminManagedDomainInput {
  readonly actorUserId: string;
  readonly name: string;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface VerifyAdminManagedDomainInput {
  readonly actorUserId: string;
  readonly domainId: string;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface DeleteAdminManagedDomainInput {
  readonly actorUserId: string;
  readonly domainId: string;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface UpdateAdminManagedDomainOutboundConnectionInput {
  readonly actorUserId: string;
  readonly domainId: string;
  readonly connectionId: string | null;
  readonly expectedUpdatedAt: string;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface AdminDomainServiceResult {
  readonly status: 200 | 201;
  readonly responseJson: string;
  readonly replayed: boolean;
}

/** Lists the safe domain projection for the admin read surface. */
export async function listAdminManagedDomains(db: Database): Promise<ManagedDomain[]> {
  const domains = await listManagedDomains(db);
  return domains.map(toManagedDomain);
}

/**
 * Assigns or clears the outbound provider connection for an active domain.
 * The D1 batch contains the binding, idempotency evidence, and audit event;
 * a compare-and-set guard prevents stale admin tabs from overwriting a newer
 * assignment.
 */
export async function updateAdminManagedDomainOutboundConnection(
  dependencies: AdminDomainServiceDependencies,
  input: UpdateAdminManagedDomainOutboundConnectionInput,
): Promise<AdminDomainServiceResult> {
  const { db } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const operation = outboundConnectionOperation(input.domainId);
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const domain = await findManagedDomainById(db, input.domainId);
  if (!domain) domainNotFound(input.domainId);
  if (domain.status !== 'active') {
    throw new DomainError({
      code: 'DOMAIN_NOT_ACTIVE',
      message: `Managed domain is not active: ${domain.name}`,
      httpStatus: 409,
    });
  }
  if (domain.updatedAt !== input.expectedUpdatedAt) {
    throw new DomainError({
      code: 'STALE_IF_MATCH',
      message: 'Domain changed since it was loaded',
      httpStatus: 412,
    });
  }

  if (input.connectionId !== null) {
    const connection = await findProviderConnectionForBinding(db, input.connectionId);
    if (!connection) {
      throw new DomainError({
        code: 'PROVIDER_CONNECTION_NOT_FOUND',
        message: 'Provider connection not found',
        httpStatus: 404,
      });
    }
    if (connection.status !== 'active') {
      throw new DomainError({
        code: 'PROVIDER_CONNECTION_NOT_ACTIVE',
        message: 'Only an active provider connection can be assigned',
        httpStatus: 409,
      });
    }
  }

  const updatedAt = nextDomainTimestamp(clock, domain.updatedAt);
  const updated: ManagedDomain = {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    outboundConnectionId: input.connectionId,
    createdAt: domain.createdAt,
    updatedAt,
  };
  const responseJson = JSON.stringify({ data: updated });
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
        createdAt: updatedAt,
      }),
      prepareUpdateDomainOutboundConnection(db, {
        domainId: input.domainId,
        connectionId: input.connectionId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        updatedAt,
      }),
      prepareRequireManagedDomainUpdated(db),
      prepareCreateAuditEvent(db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'domain.outbound_connection.updated',
        resourceType: 'managed_domain',
        resourceId: input.domainId,
        requestId: input.requestId,
        metadata: JSON.stringify({ connectionId: input.connectionId }),
        createdAt: updatedAt,
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
    if (isDomainRevisionConflict(error)) {
      const replay = await replayIfPresent(
        db,
        input.actorUserId,
        operation,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) return replay;
      throw new DomainError({
        code: 'STALE_IF_MATCH',
        message: 'Domain changed while this update was being saved',
        httpStatus: 412,
        cause: error,
      });
    }
    throw error;
  }
  return { status: 200, responseJson, replayed: false };
}

/** Adds a domain and atomically records its audit/idempotency evidence. */
export async function createAdminManagedDomain(
  dependencies: AdminDomainServiceDependencies,
  input: CreateAdminManagedDomainInput,
): Promise<AdminDomainServiceResult> {
  const { db } = dependencies;
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

  const id = ids.uuid();
  const now = sqliteTimestamp(clock.now());
  const domain: ManagedDomain = {
    id,
    name: input.name,
    status: 'active',
    outboundConnectionId: null,
    createdAt: now,
    updatedAt: now,
  };
  const responseJson = JSON.stringify({ data: domain });

  try {
    await db.batch([
      // The unique index serializes same-key requests before a business
      // UNIQUE conflict can make the loser look like a different request.
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
      prepareCreateDomain(db, {
        id,
        name: domain.name,
        status: domain.status,
        outboundConnectionId: null,
        createdAt: now,
        updatedAt: now,
      }),
      prepareCreateAuditEvent(db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'domain.created',
        resourceType: 'managed_domain',
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
    throw mapDomainWriteError(error);
  }

  return { status: 201, responseJson, replayed: false };
}

/** Records the Phase 1 operator-confirmation action for an active domain. */
export async function verifyAdminManagedDomain(
  dependencies: AdminDomainServiceDependencies,
  input: VerifyAdminManagedDomainInput,
): Promise<AdminDomainServiceResult> {
  const { db } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const operation = verifyOperation(input.domainId);
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const domain = await findManagedDomainById(db, input.domainId);
  if (!domain) domainNotFound(input.domainId);
  if (domain.status !== 'active') {
    throw new DomainError({
      code: 'DOMAIN_NOT_ACTIVE',
      message: `Managed domain is not active: ${domain.name}`,
      httpStatus: 409,
    });
  }

  const responseJson = JSON.stringify({ data: { verified: true, domain: domain.name } });
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
      prepareCreateAuditEvent(db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'domain.verified',
        resourceType: 'managed_domain',
        resourceId: input.domainId,
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
    throw error;
  }

  return { status: 200, responseJson, replayed: false };
}

/** Deletes an unused domain and atomically records the successful transition. */
export async function deleteAdminManagedDomain(
  dependencies: AdminDomainServiceDependencies,
  input: DeleteAdminManagedDomainInput,
): Promise<AdminDomainServiceResult> {
  const { db } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const operation = deleteOperation(input.domainId);
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const domain = await findManagedDomainById(db, input.domainId);
  if (!domain) domainNotFound(input.domainId);
  if ((await countMailboxesForDomain(db, input.domainId)) > 0) {
    throw new DomainError({
      code: 'DOMAIN_IN_USE',
      message: `Managed domain is used by one or more mailboxes: ${domain.name}`,
      httpStatus: 409,
    });
  }

  const responseJson = JSON.stringify({ data: { id: input.domainId, deleted: true } });
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
      prepareDeleteDomain(db, input.domainId),
      prepareRequireManagedDomainDeleted(db),
      prepareCreateAuditEvent(db, {
        id: ids.uuid(),
        actorUserId: input.actorUserId,
        action: 'domain.deleted',
        resourceType: 'managed_domain',
        resourceId: input.domainId,
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
    if (isDeleteGuardFailure(error)) {
      const winner = await replayIfPresent(
        db,
        input.actorUserId,
        operation,
        input.idempotencyKey,
        input.requestHash,
      );
      if (winner) return winner;

      const current = await findManagedDomainById(db, input.domainId);
      if (!current) domainNotFound(input.domainId, error);
      if ((await countMailboxesForDomain(db, input.domainId)) === 0) {
        throw new DomainError({
          code: 'INTERNAL',
          message: 'Managed domain delete did not affect the target row',
          httpStatus: 500,
          cause: error,
        });
      }
      throw new DomainError({
        code: 'DOMAIN_IN_USE',
        message: `Managed domain is used by one or more mailboxes: ${domain.name}`,
        httpStatus: 409,
        cause: error,
      });
    }
    throw error;
  }

  return { status: 200, responseJson, replayed: false };
}

async function replayIfPresent(
  db: Database,
  actorUserId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<AdminDomainServiceResult | null> {
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
): Promise<AdminDomainServiceResult> {
  const replay = await replayIfPresent(db, actorUserId, operation, idempotencyKey, requestHash);
  if (replay) return replay;
  throw new DomainError({
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Concurrent request with the same Idempotency-Key is in flight',
    httpStatus: 409,
  });
}

function verifyOperation(domainId: string): string {
  return `POST /api/v1/admin/domains/${domainId}/verify`;
}

function deleteOperation(domainId: string): string {
  return `DELETE /api/v1/admin/domains/${domainId}`;
}

function outboundConnectionOperation(domainId: string): string {
  return `PATCH /api/v1/admin/domains/${domainId}/outbound-connection`;
}

function nextDomainTimestamp(clock: Clock, currentUpdatedAt: string): string {
  const candidate = sqliteTimestamp(clock.now());
  const currentMillis = Date.parse(`${currentUpdatedAt.replace(' ', 'T')}Z`);
  const candidateMillis = Date.parse(`${candidate.replace(' ', 'T')}Z`);
  if (Number.isFinite(currentMillis) && candidateMillis <= currentMillis) {
    return sqliteTimestamp(new Date(currentMillis + 1000));
  }
  return candidate;
}

function isDomainRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('CHECK constraint failed');
}

function domainNotFound(domainId: string, cause?: unknown): never {
  throw new DomainError({
    code: 'DOMAIN_NOT_FOUND',
    message: `Managed domain not found: ${domainId}`,
    httpStatus: 404,
    ...(cause === undefined ? {} : { cause }),
  });
}

function toManagedDomain(domain: ManagedDomainInfo): ManagedDomain {
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    outboundConnectionId: domain.outboundConnectionId,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}

function mapDomainWriteError(error: unknown): DomainError {
  if (isManagedDomainNameUniqueViolation(error)) {
    return new DomainError({
      code: 'DOMAIN_ALREADY_MANAGED',
      message: 'A domain with this name already exists',
      httpStatus: 409,
      cause: error,
    });
  }
  return error instanceof DomainError
    ? error
    : new DomainError({
        code: 'INTERNAL',
        message: 'Unable to manage domain',
        httpStatus: 500,
        cause: error,
      });
}

function isManagedDomainNameUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed: managed_domains.name')
  );
}

function isDeleteGuardFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('CHECK constraint failed');
}
