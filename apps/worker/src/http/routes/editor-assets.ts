import { buildAppContext } from '../../app-context';
import { Hono } from 'hono';
import { attachmentUploadMetadataSchema } from '@unimailbox/contracts';
import { getEditorUploadPolicy } from '../../modules/admin';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { assertCan, findManagedDomainById } from '../../modules/tenancy';
import { uploadEditorAsset, invalidAsset, type EditorAssetRow } from '../../modules/editor-assets';
import { sha256Hex, sqliteTimestamp } from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import type { Handler } from 'hono';

const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const upload: Handler<AppEnv> = async (c) => {
  const userId = c.get('userId');
  const idempotencyKey = c.get('idempotencyKey');
  if (!userId)
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  if (!idempotencyKey)
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  const mailboxId = c.req.param('mailboxId') ?? null;
  const domainId = c.req.param('domainId') ?? null;
  if (mailboxId) {
    try {
      await assertCan(c.env.DB, userId, mailboxId, 'send');
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === 'MAILBOX_NOT_FOUND' || error.code === 'MAILBOX_ACCESS_DENIED')
      )
        throw new DomainError({
          code: 'MAILBOX_NOT_FOUND',
          message: 'Mailbox not found',
          httpStatus: 404,
        });
      throw error;
    }
  } else if (!domainId || !(await findManagedDomainById(c.env.DB, domainId)))
    throw invalidAsset('Domain not found');
  const kind = c.req.header('X-Asset-Kind');
  if (kind !== 'image' && kind !== 'file') throw invalidAsset('Invalid upload kind');
  let filename: string;
  try {
    filename = decodeURIComponent(c.req.header('X-Filename') ?? '');
  } catch {
    throw invalidAsset('Invalid filename');
  }
  const metadata = attachmentUploadMetadataSchema.parse({
    filename,
    contentType: c.req.header('Content-Type'),
  });
  const policy = await getEditorUploadPolicy(c.env.DB);
  const max = kind === 'image' ? policy.maxImageBytes : policy.maxFileBytes;
  if (Number(c.req.header('Content-Length')) > max)
    throw new DomainError({
      code: 'BODY_TOO_LARGE',
      message: `File exceeds ${max} bytes`,
      httpStatus: 413,
    });
  const sizeBytes = Number(c.req.header('X-File-Size'));
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)
    throw invalidAsset('File size is required');
  if (sizeBytes > max)
    throw new DomainError({
      code: 'BODY_TOO_LARGE',
      message: `File exceeds ${max} bytes`,
      httpStatus: 413,
    });
  const result = await uploadEditorAsset(
    {
      db: c.env.DB,
      bucket: c.env.ATTACHMENTS,
      auditEventWriter: buildAppContext(c.env).auditEventWriter,
    },
    {
      requestId: c.get('requestId') ?? null,
      actorUserId: userId,
      mailboxId,
      domainId,
      kind,
      metadata,
      sizeBytes,
      body: c.req.raw.body,
      operation: `POST ${c.req.path}`,
      idempotencyKey,
      origin: c.req.url,
    },
  );
  return new Response(result.responseJson, {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
export function editorAssetRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get('/editor-assets/policy', async (c) => {
    if (!c.get('userId'))
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    c.header('Cache-Control', 'private, no-store');
    return c.json({ data: await getEditorUploadPolicy(c.env.DB) });
  });
  routes.post(
    '/mailboxes/:mailboxId/editor-assets',
    requirePermission('message.send'),
    requireIdempotencyKey,
    upload,
  );
  routes.post(
    '/admin/domains/:domainId/editor-assets',
    requirePermission('signature.manage'),
    requireIdempotencyKey,
    upload,
  );
  // Explicit capability URL for recipients. Never exposes private incoming attachments.
  routes.get('/editor-assets/:id/:secret', async (c) => {
    const id = c.req.param('id');
    const secret = c.req.param('secret');
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(secret)) return c.notFound();
    const row = await c.env.DB.prepare(
      `SELECT a.* FROM editor_assets a WHERE id=? AND (expires_at>? OR EXISTS(SELECT 1 FROM editor_asset_usages WHERE asset_id=a.id))`,
    )
      .bind(id, sqliteTimestamp(new Date()))
      .first<EditorAssetRow>();
    if (!row || row.secret_hash !== (await sha256Hex(secret))) return c.notFound();
    const object = await c.env.ATTACHMENTS.get(row.object_key);
    if (!object) return c.notFound();
    const inline = row.kind === 'image' && RASTER_TYPES.has(row.content_type);
    return new Response(object.body, {
      headers: {
        'Content-Type': inline ? row.content_type : 'application/octet-stream',
        'Content-Length': String(object.size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer',
      },
    });
  });
  return routes;
}
