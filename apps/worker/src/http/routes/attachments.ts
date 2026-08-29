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
import { uploadAttachment } from '../../modules/attachments';
import { assertCan } from '../../modules/tenancy';
import { checkPermission } from '../../modules/admin';
import { buildAppContext } from '../../app-context';
import { getAttachmentByteStore } from '../../platform/cache';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

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
      const isAdmin = await checkPermission(c.env.DB, userId, 'role.manage');
      try {
        await assertCan(c.env.DB, userId, mailboxId, 'send', isAdmin);
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
          isAdmin,
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
