import type { AuditEventInput, AuditEventWriter } from '@unimailbox/contracts';
import type { Clock } from './clock';
import type { Database } from './database';
import type { IdGenerator } from './ids';
import { DomainError } from './errors';
import {
  assertSameRequestHash,
  findIdempotencyRecord,
  type IdempotencyRecord,
} from './idempotency';

/** Serialized outcome shared by HTTP and MCP; only transports construct Responses. */
export interface OperationResult {
  readonly responseStatus: number;
  readonly responseJson: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface MutationDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly auditEventWriter: AuditEventWriter;
}

/** Raw material is retained so existing idempotency hashes remain byte-compatible. */
export interface MutationInput {
  readonly actorUserId: string | undefined;
  readonly rawBody: string;
  readonly idempotencyKey: string | undefined;
  readonly requestId: string | undefined;
}

export function operationResult(
  body: string | null,
  init: { status: number; headers?: Readonly<Record<string, string>> },
): OperationResult {
  return { responseStatus: init.status, responseJson: body ?? '', headers: init.headers ?? {} };
}

export function replayOperation(record: IdempotencyRecord): OperationResult {
  return operationResult(record.responseJson, {
    status: record.responseStatus,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function replayOperationAfterRace(
  db: Database,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<OperationResult> {
  const winner = await findIdempotencyRecord(db, actorId, operation, idempotencyKey);
  if (!winner)
    throw new DomainError({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Concurrent request with the same Idempotency-Key is in flight',
      httpStatus: 409,
    });
  assertSameRequestHash(winner, requestHash);
  return replayOperation(winner);
}

/** The audit contract intentionally exposes only the structural statement subset. */
export function prepareOperationAudit(
  writer: AuditEventWriter,
  input: AuditEventInput,
  guard?: { readonly idempotencyMarkerId: string },
): D1PreparedStatement {
  return writer.prepare(input, guard).statement as D1PreparedStatement;
}
