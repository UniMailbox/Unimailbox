// CAP-049 raw-binary attachment staging route.

import { Hono } from 'hono';
import {
  ATTACHMENT_DISPOSITION_HEADER,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  attachmentUploadMetadataSchema,
} from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { downloadAttachment, uploadAttachment } from '../../modules/attachments';
import { assertCan } from '../../modules/tenancy';
import { buildAppContext } from '../../app-context';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../../platform/cache';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

function attachmentNotFound(): never {
  // Keep every attachment existence/authorization/byte-store failure on the
  // same stable envelope. MESSAGE_NOT_FOUND is the existing 404 catalog code;
  // the closed error catalog does not expose a second attachment code.
  throw new DomainError({
    code: 'MESSAGE_NOT_FOUND',
    message: 'Attachment not found',
    httpStatus: 404,
  });
}

function encodeFilenameParameter(filename: string): string {
  const bytes = new TextEncoder().encode(filename);
  return Array.from(bytes, (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(
    '',
  );
}

function contentDisposition(filename: string): string {
  // The ASCII fallback prevents path separators, quotes, and control/non-ASCII
  // characters from becoming unsafe header syntax. filename* retains the
  // canonical UTF-8 name for clients that support RFC 5987.
  const fallback = filename.replace(/[^\x20-\x7e]|[\\"/]/g, '_') || 'attachment';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeFilenameParameter(filename)}`;
}

function rejectOversizedContentLength(contentLength: string | undefined): void {
  if (!contentLength) return;
  const declared = Number.parseInt(contentLength, 10);
  if (Number.isFinite(declared) && declared > ATTACHMENT_UPLOAD_MAX_BYTES) {
    throw new DomainError({
      code: 'BODY_TOO_LARGE',
      message: `Request body exceeds ${ATTACHMENT_UPLOAD_MAX_BYTES} bytes`,
      httpStatus: 413,
    });
  }
}

/** Read a binary request without retaining more than the configured cap. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (total + chunk.byteLength > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is the stable response; cancellation failure
          // must not obscure it.
        }
        throw new DomainError({
          code: 'BODY_TOO_LARGE',
          message: `Request body exceeds ${maxBytes} bytes`,
          httpStatus: 413,
        });
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export function attachmentRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get(
    '/mailboxes/:mailboxId/attachments/:attachmentId/download',
    requirePermission('message.read'),
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }

      const mailboxId = c.req.param('mailboxId');
      const attachmentId = c.req.param('attachmentId');

      let result;
      try {
        result = await downloadAttachment(
          {
            db: c.env.DB,
            cache: getAttachmentByteStore(c.env),
            objectStore: getAttachmentObjectStore(c.env),
          },
          {
            actorUserId: userId,
            mailboxId,
            attachmentId,
          },
        );
      } catch (error) {
        // The path mailbox is part of the protected resource identity. A
        // foreign/nonexistent mailbox and every inaccessible attachment state
        // collapse to one 404, with no D1 metadata or CACHE distinction.
        if (
          error instanceof DomainError &&
          (error.code === 'MAILBOX_NOT_FOUND' ||
            error.code === 'MAILBOX_ACCESS_DENIED' ||
            error.code === 'MESSAGE_NOT_FOUND')
        ) {
          attachmentNotFound();
        }
        throw error;
      }

      const response = new Response(result.bytes, {
        status: 200,
        headers: {
          'Content-Type': result.contentType,
          'Content-Length': String(result.sizeBytes),
          // Every direct navigation downloads as a file. Inline raster
          // previews use an authenticated fetch and document-scoped object
          // URL, so attacker-controlled MIME never executes on our origin.
          'Content-Disposition': contentDisposition(result.filename),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': 'sandbox',
        },
      });
      const requestId = c.get('requestId');
      if (requestId) response.headers.set('X-Request-Id', requestId);
      return response;
    },
  );

  routes.post(
    '/mailboxes/:mailboxId/attachments/uploads',
    requirePermission('message.send'),
    requireIdempotencyKey,
    async (c) => {
      const userId = c.get('userId');
      const idempotencyKey = c.get('idempotencyKey');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }

      const mailboxId = c.req.param('mailboxId');
      // Authorize the target mailbox before reading an untrusted body. The
      // use case repeats the check at its own boundary for defense in depth.
      try {
        await assertCan(c.env.DB, userId, mailboxId, 'send');
      } catch (error) {
        // A mailbox upload must not disclose whether a foreign mailbox UUID
        // exists. Collapse both tenancy outcomes to the same 404 envelope.
        if (error instanceof DomainError) {
          if (error.code === 'MAILBOX_ACCESS_DENIED' || error.code === 'MAILBOX_NOT_FOUND') {
            throw new DomainError({
              code: 'MAILBOX_NOT_FOUND',
              message: 'Mailbox not found',
              httpStatus: 404,
            });
          }
        }
        throw error;
      }

      rejectOversizedContentLength(c.req.header('Content-Length'));
      const metadata = attachmentUploadMetadataSchema.parse({
        filename: c.req.header(ATTACHMENT_FILENAME_HEADER),
        contentType: c.req.header('Content-Type'),
        disposition: c.req.header(ATTACHMENT_DISPOSITION_HEADER) ?? undefined,
      });
      const bytes = await readBoundedBody(c.req.raw, ATTACHMENT_UPLOAD_MAX_BYTES);
      const ctx = buildAppContext(c.env);

      const result = await uploadAttachment(
        {
          db: c.env.DB,
          cache: getAttachmentByteStore(c.env),
          auditEventWriter: ctx.auditEventWriter,
        },
        {
          actorUserId: userId,
          mailboxId,
          idempotencyKey,
          requestId: c.get('requestId') ?? null,
          metadata,
          bytes,
        },
      );

      return new Response(result.responseJson, {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  return routes;
}
