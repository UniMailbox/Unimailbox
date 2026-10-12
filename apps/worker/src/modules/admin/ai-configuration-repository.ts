import { aiConfigurationSchema, type AiConfiguration } from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import type { Database } from '../../platform/database';

export interface AiConfigurationSnapshot {
  readonly configuration: AiConfiguration;
  readonly revision: number;
  readonly credential: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array } | null;
}
interface Row {
  configuration: string;
  revision: number;
  ciphertext: ArrayBuffer | null;
  iv: ArrayBuffer | null;
  auth_tag: ArrayBuffer | null;
}
export async function readAiConfiguration(db: Database): Promise<AiConfigurationSnapshot> {
  const row = await db
    .prepare(
      'SELECT configuration, revision, ciphertext, iv, auth_tag FROM ai_configuration WHERE id = ?',
    )
    .bind('system')
    .first<Row>();
  if (!row) throw new Error('AI configuration migration is missing');
  let configuration: AiConfiguration;
  try {
    configuration = aiConfigurationSchema.parse(JSON.parse(row.configuration));
  } catch {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'Stored AI configuration is invalid',
      httpStatus: 500,
    });
  }
  return {
    configuration,
    revision: row.revision,
    credential:
      row.ciphertext && row.iv && row.auth_tag
        ? {
            ciphertext: new Uint8Array(row.ciphertext),
            iv: new Uint8Array(row.iv),
            authTag: new Uint8Array(row.auth_tag),
          }
        : null,
  };
}
export function prepareUpdateAiConfiguration(
  db: Database,
  snapshot: AiConfigurationSnapshot,
  expectedRevision: number,
  updatedAt: string,
): D1PreparedStatement {
  // CHECK forces a losing CAS to abort the entire batch (including audit/replay).
  return db
    .prepare(
      `UPDATE ai_configuration SET configuration = ?, ciphertext = ?, iv = ?, auth_tag = ?,
    revision = CASE WHEN revision = ? THEN revision + 1 ELSE -1 END, updated_at = ? WHERE id = 'system'`,
    )
    .bind(
      JSON.stringify(snapshot.configuration),
      snapshot.credential?.ciphertext ?? null,
      snapshot.credential?.iv ?? null,
      snapshot.credential?.authTag ?? null,
      expectedRevision,
      updatedAt,
    );
}
