// Signature administration use cases — CAP-068.
// The route supplies transport parsing and the audit writer. This module
// owns target resolution, sanitization, atomic D1 writes, and replay rules.

import { prepareEditorAssetUsages } from '../editor-assets';
import { signatureSchema } from '@unimailbox/contracts';
import type {
  AuditEventWriter,
  CreateSignatureRequest,
  Signature,
  UpdateSignatureRequest,
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
import { findManagedDomainById } from '../tenancy';
import {
  findEnabledSignature as findEnabledSignatureRow,
  findSignatureByDomainId,
  findSignatureById,
  listSignatures,
  prepareCreateSignature,
  prepareDeleteSignature,
  prepareRequireSignatureDeleted,
  prepareRequireSignatureUpdated,
  prepareUpdateSignature,
  toSignature,
  type SignatureStorageRow,
} from './signature-repository';
import { sanitizeSignatureHtml } from './signature-sanitizer';

const CREATE_OPERATION = 'POST /api/v1/admin/signatures';

export interface SignatureAdministrationDependencies {
  readonly db: Database;
  readonly auditEventWriter: AuditEventWriter;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface CreateAdminSignatureInput {
  readonly actorUserId: string;
  readonly request: CreateSignatureRequest;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface UpdateAdminSignatureInput {
  readonly actorUserId: string;
  readonly signatureId: string;
  readonly request: UpdateSignatureRequest;
  readonly expectedUpdatedAt: string;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface DeleteAdminSignatureInput {
  readonly actorUserId: string;
  readonly signatureId: string;
  readonly requestId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface SignatureAdministrationResult {
  readonly status: 200 | 201;
  readonly responseJson: string;
  readonly replayed: boolean;
}

export async function listAdminSignatures(db: Database): Promise<Signature[]> {
  return (await listSignatures(db)).map(toValidatedSignature);
}

/** Exposed for the later outbound compose use case; disabled rows are absent. */
export async function findEnabledSignature(
  db: Database,
  domainId: string,
): Promise<Signature | null> {
  const row = await findEnabledSignatureRow(db, domainId);
  return row === null ? null : toValidatedSignature(row);
}

export async function createAdminSignature(
  dependencies: SignatureAdministrationDependencies,
  input: CreateAdminSignatureInput,
): Promise<SignatureAdministrationResult> {
  const { db, auditEventWriter } = dependencies;
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

  const domain = await findManagedDomainById(db, input.request.domainId);
  if (domain === null) domainNotFound(input.request.domainId);
  if (await findSignatureByDomainId(db, input.request.domainId)) {
    throw signatureAlreadyExists(input.request.domainId);
  }

  const now = sqliteTimestamp(clock.now());
  const content = prepareSignatureContent(input.request.htmlContent, input.request.textContent);
  const signature = signatureProjection({
    id: ids.uuid(),
    domain_id: input.request.domainId,
    domain_name: domain.name,
    html_content: content.htmlContent,
    text_content: content.textContent,
    is_enabled: input.request.isEnabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  const responseJson = JSON.stringify({ data: signature });
  const auditStatement = auditEventWriter.prepare({
    id: ids.uuid(),
    actorUserId: input.actorUserId,
    action: 'signature.created',
    resourceType: 'domain_signature',
    resourceId: signature.id,
    requestId: input.requestId,
    metadata: JSON.stringify({ domainId: signature.domainId }),
    createdAt: now,
  }).statement as unknown as D1PreparedStatement;

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
      prepareCreateSignature(db, {
        id: signature.id,
        domainId: signature.domainId,
        htmlContent: signature.htmlContent,
        textContent: signature.textContent,
        isEnabled: signature.isEnabled,
        createdAt: now,
        updatedAt: now,
      }),
      ...(await prepareEditorAssetUsages(db, {
        html: signature.htmlContent,
        text: signature.textContent,
        actorUserId: input.actorUserId,
        scope: { domainId: signature.domainId },
        resourceType: 'signature',
        resourceId: signature.id,
      })),
      auditStatement,
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
    if (isSignatureDomainUniqueViolation(error)) {
      const replayAfterSignatureRace = await replayIfPresent(
        db,
        input.actorUserId,
        CREATE_OPERATION,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replayAfterSignatureRace) return replayAfterSignatureRace;
      throw signatureAlreadyExists(input.request.domainId, error);
    }
    throw error;
  }

  return { status: 201, responseJson, replayed: false };
}

export async function updateAdminSignature(
  dependencies: SignatureAdministrationDependencies,
  input: UpdateAdminSignatureInput,
): Promise<SignatureAdministrationResult> {
  const { db, auditEventWriter } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const operation = signatureOperation('PATCH', input.signatureId);
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const current = await findSignatureById(db, input.signatureId);
  if (current === null) signatureNotFound(input.signatureId);
  if (current.updated_at !== input.expectedUpdatedAt) {
    staleSignature(input.signatureId);
  }
  const now = nextSignatureTimestamp(current.updated_at, clock.now());
  const content = prepareSignatureContent(input.request.htmlContent, input.request.textContent);
  const signature = signatureProjection({
    ...current,
    html_content: content.htmlContent,
    text_content: content.textContent,
    is_enabled: input.request.isEnabled ? 1 : 0,
    updated_at: now,
  });
  const responseJson = JSON.stringify({ data: signature });
  const auditStatement = auditEventWriter.prepare({
    id: ids.uuid(),
    actorUserId: input.actorUserId,
    action: 'signature.updated',
    resourceType: 'domain_signature',
    resourceId: signature.id,
    requestId: input.requestId,
    metadata: JSON.stringify({ domainId: signature.domainId }),
    createdAt: now,
  }).statement as unknown as D1PreparedStatement;

  try {
    await db.batch([
      prepareUpdateSignature(db, {
        id: signature.id,
        expectedUpdatedAt: current.updated_at,
        htmlContent: signature.htmlContent,
        textContent: signature.textContent,
        isEnabled: signature.isEnabled,
        updatedAt: now,
      }),
      prepareRequireSignatureUpdated(db, signature.id),
      ...(await prepareEditorAssetUsages(db, {
        html: signature.htmlContent,
        text: signature.textContent,
        actorUserId: input.actorUserId,
        scope: { domainId: signature.domainId },
        resourceType: 'signature',
        resourceId: signature.id,
      })),
      auditStatement,
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
    if (isSignatureWriteGuardFailure(error)) {
      const latest = await findSignatureById(db, input.signatureId);
      if (latest === null) {
        const replay = await replayIfPresent(
          db,
          input.actorUserId,
          operation,
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay) return replay;
        signatureNotFound(input.signatureId, error);
      }
      const replay = await replayIfPresent(
        db,
        input.actorUserId,
        operation,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) return replay;
      throw staleSignature(input.signatureId, error);
    }
    throw error;
  }

  return { status: 200, responseJson, replayed: false };
}

export async function deleteAdminSignature(
  dependencies: SignatureAdministrationDependencies,
  input: DeleteAdminSignatureInput,
): Promise<SignatureAdministrationResult> {
  const { db, auditEventWriter } = dependencies;
  const ids = dependencies.ids ?? systemIds;
  const clock = dependencies.clock ?? systemClock;
  const operation = signatureOperation('DELETE', input.signatureId);
  const replay = await replayIfPresent(
    db,
    input.actorUserId,
    operation,
    input.idempotencyKey,
    input.requestHash,
  );
  if (replay) return replay;

  const current = await findSignatureById(db, input.signatureId);
  if (current === null) signatureNotFound(input.signatureId);
  const now = sqliteTimestamp(clock.now());
  const responseJson = JSON.stringify({ data: { id: input.signatureId, deleted: true } });
  const auditStatement = auditEventWriter.prepare({
    id: ids.uuid(),
    actorUserId: input.actorUserId,
    action: 'signature.deleted',
    resourceType: 'domain_signature',
    resourceId: input.signatureId,
    requestId: input.requestId,
    metadata: JSON.stringify({ domainId: current.domain_id }),
    createdAt: now,
  }).statement as unknown as D1PreparedStatement;

  try {
    await db.batch([
      prepareDeleteSignature(db, input.signatureId),
      prepareRequireSignatureDeleted(db, input.signatureId),
      auditStatement,
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
    if (isSignatureWriteGuardFailure(error)) {
      const latest = await findSignatureById(db, input.signatureId);
      if (latest === null) {
        const replay = await replayIfPresent(
          db,
          input.actorUserId,
          operation,
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay) return replay;
        signatureNotFound(input.signatureId, error);
      }
    }
    throw error;
  }

  return { status: 200, responseJson, replayed: false };
}

function signatureProjection(row: SignatureStorageRow): Signature {
  return toValidatedSignature(row);
}

function toValidatedSignature(row: SignatureStorageRow): Signature {
  const signature = toSignature(row);
  if (!Number.isInteger(row.is_enabled) || (row.is_enabled !== 0 && row.is_enabled !== 1)) {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'Stored signature data failed validation',
      httpStatus: 500,
    });
  }
  const parsed = signatureSchema.safeParse(signature);
  if (!parsed.success) {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'Stored signature data failed validation',
      httpStatus: 500,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

async function replayIfPresent(
  db: Database,
  actorUserId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<SignatureAdministrationResult | null> {
  const record = await findIdempotencyRecord(db, actorUserId, operation, idempotencyKey);
  if (record === null) return null;
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
): Promise<SignatureAdministrationResult> {
  const replay = await replayIfPresent(db, actorUserId, operation, idempotencyKey, requestHash);
  if (replay) return replay;
  throw new DomainError({
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Concurrent request with the same Idempotency-Key is in flight',
    httpStatus: 409,
  });
}

function signatureOperation(method: 'PATCH' | 'DELETE', signatureId: string): string {
  return `${method} /api/v1/admin/signatures/${signatureId}`;
}

function domainNotFound(domainId: string, cause?: unknown): never {
  throw new DomainError({
    code: 'DOMAIN_NOT_FOUND',
    message: `Managed domain not found: ${domainId}`,
    httpStatus: 404,
    ...(cause === undefined ? {} : { cause }),
  });
}

function signatureNotFound(signatureId: string, cause?: unknown): never {
  throw new DomainError({
    code: 'SIGNATURE_NOT_FOUND',
    message: `Signature not found: ${signatureId}`,
    httpStatus: 404,
    ...(cause === undefined ? {} : { cause }),
  });
}

function signatureAlreadyExists(domainId: string, cause?: unknown): DomainError {
  return new DomainError({
    code: 'SIGNATURE_ALREADY_EXISTS',
    message: `A signature already exists for domain: ${domainId}`,
    httpStatus: 409,
    ...(cause === undefined ? {} : { cause }),
  });
}

function staleSignature(signatureId: string, cause?: unknown): never {
  throw new DomainError({
    code: 'STALE_IF_MATCH',
    message: `Signature has changed since it was read: ${signatureId}`,
    httpStatus: 412,
    ...(cause === undefined ? {} : { cause }),
  });
}

function nextSignatureTimestamp(previous: string, candidateDate: Date): string {
  const candidate = sqliteTimestamp(candidateDate);
  if (candidate > previous) return candidate;
  const advanced = new Date(`${previous.replace(' ', 'T')}Z`);
  advanced.setUTCSeconds(advanced.getUTCSeconds() + 1);
  return sqliteTimestamp(advanced);
}

function isSignatureDomainUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('domain_signatures.domain_id');
}

function prepareSignatureContent(
  htmlContent: string,
  textContent: string,
): { readonly htmlContent: string; readonly textContent: string } {
  const sanitizedHtml = sanitizeSignatureHtml(htmlContent);
  if (sanitizedHtml.trim().length === 0 && textContent.trim().length === 0) {
    throw new DomainError({
      code: 'VALIDATION_ERROR',
      message: 'Signature must contain usable HTML or plain-text content',
      httpStatus: 400,
    });
  }
  return { htmlContent: sanitizedHtml, textContent };
}

function isSignatureWriteGuardFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('CHECK constraint failed');
}
