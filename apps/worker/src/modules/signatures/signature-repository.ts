// Signature persistence — CAP-068.
// The signatures module owns the domain_signatures table. SQL is kept
// parameterized and batch-friendly so administration can compose the row
// write with its audit and idempotency evidence.

import type { Signature } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';

export interface SignatureStorageRow {
  readonly id: string;
  readonly domain_id: string;
  readonly domain_name: string;
  readonly html_content: string;
  readonly text_content: string;
  readonly is_enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateSignatureStorageInput {
  readonly id: string;
  readonly domainId: string;
  readonly htmlContent: string;
  readonly textContent: string;
  readonly isEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateSignatureStorageInput {
  readonly id: string;
  readonly expectedUpdatedAt: string;
  readonly htmlContent: string;
  readonly textContent: string;
  readonly isEnabled: boolean;
  readonly updatedAt: string;
}

const SIGNATURE_SELECT = `
  SELECT s.id, s.domain_id, d.name AS domain_name,
         s.html_content, s.text_content, s.is_enabled,
         s.created_at, s.updated_at
    FROM domain_signatures AS s
    JOIN managed_domains AS d ON d.id = s.domain_id
`;

export async function listSignatures(db: Database): Promise<SignatureStorageRow[]> {
  const result = await db
    .prepare(`${SIGNATURE_SELECT} ORDER BY d.name COLLATE NOCASE ASC, d.id ASC`)
    .all<SignatureStorageRow>();
  return result.results;
}

export async function findSignatureById(
  db: Database,
  signatureId: string,
): Promise<SignatureStorageRow | null> {
  return db
    .prepare(`${SIGNATURE_SELECT} WHERE s.id = ? LIMIT 1`)
    .bind(signatureId)
    .first<SignatureStorageRow>();
}

export async function findSignatureByDomainId(
  db: Database,
  domainId: string,
): Promise<SignatureStorageRow | null> {
  return db
    .prepare(`${SIGNATURE_SELECT} WHERE s.domain_id = ? LIMIT 1`)
    .bind(domainId)
    .first<SignatureStorageRow>();
}

export async function findEnabledSignature(
  db: Database,
  domainId: string,
): Promise<SignatureStorageRow | null> {
  return db
    .prepare(`${SIGNATURE_SELECT} WHERE s.domain_id = ? AND s.is_enabled = 1 LIMIT 1`)
    .bind(domainId)
    .first<SignatureStorageRow>();
}

export function prepareCreateSignature(
  db: Database,
  input: CreateSignatureStorageInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO domain_signatures
         (id, domain_id, html_content, text_content, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.domainId,
      input.htmlContent,
      input.textContent,
      input.isEnabled ? 1 : 0,
      input.createdAt,
      input.updatedAt,
    );
}

export function prepareUpdateSignature(
  db: Database,
  input: UpdateSignatureStorageInput,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE domain_signatures
          SET html_content = ?, text_content = ?, is_enabled = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?`,
    )
    .bind(
      input.htmlContent,
      input.textContent,
      input.isEnabled ? 1 : 0,
      input.updatedAt,
      input.id,
      input.expectedUpdatedAt,
    );
}

/** Fails a batch if a concurrent delete made the preceding update a no-op. */
export function prepareRequireSignatureUpdated(
  db: Database,
  signatureId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO domain_signatures
         (id, domain_id, html_content, text_content, is_enabled, created_at, updated_at)
       SELECT ?, ?, '', '', 2, '', '' WHERE changes() = 0`,
    )
    .bind(signatureId, '00000000-0000-4000-8000-000000000000');
}

export function prepareDeleteSignature(db: Database, signatureId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM domain_signatures WHERE id = ?').bind(signatureId);
}

/** Fails a batch if a concurrent delete made the preceding delete a no-op. */
export function prepareRequireSignatureDeleted(
  db: Database,
  signatureId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO domain_signatures
         (id, domain_id, html_content, text_content, is_enabled, created_at, updated_at)
       SELECT ?, ?, '', '', 2, '', '' WHERE changes() = 0`,
    )
    .bind(signatureId, '00000000-0000-4000-8000-000000000000');
}

export function toSignature(row: SignatureStorageRow): Signature {
  return {
    id: row.id,
    domainId: row.domain_id,
    domainName: row.domain_name,
    htmlContent: row.html_content,
    textContent: row.text_content,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
