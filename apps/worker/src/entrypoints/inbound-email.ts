// Inbound-email entry — Email Routing handler.
// CAP-021: Real inbound mail processing with MIME parsing.
// D-CAP-021 / CAP-035: Blocklist + per-role policy evaluation before
// persistence.
//
// Flow:
// 1. Check if this is a smoke test message (CAP-013 backward compatibility)
// 2. Read raw email stream
// 3. Parse MIME headers and body
// 4. Resolve the Cloudflare envelope recipient to one active mailbox
// 5. If no mailbox found: reject (unknown recipient)
// 6. D-CAP-021: load blocklist + recipient mailbox owners' role policies and
//    evaluate the policy. If rejected, call message.setReject(reason) and
//    return — no DB writes, no audit (per Decision §Q4).
// 7. If mailbox found: create message + recipients + mailbox_messages in one
//    D1 batch (R-INBOUND-008).
// 8. R-AUDIT-001: write audit event for the success transition.
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
// R-INBOUND-005: Blocklist matches on subject/content/from
// R-INBOUND-006: Per-role banEmail + availDomain policies
// R-DATA-001:    Email addresses are case-insensitive

import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { handleSmokeTestMessage } from '../modules/onboarding';
import { normalizeAddress, parseInboundMime } from '@unimailbox/email-core';
import { attachmentContentTypeSchema, attachmentFilenameSchema } from '@unimailbox/contracts';
import { findMailboxByAddress } from '../modules/tenancy';
import {
  prepareCreateMessage,
  prepareCreateRecipient,
  prepareCreateMailboxMessage,
  createMessageWithRelations,
  prepareCreateInboundAttachment,
  type CreateMessageInput,
  type CreateRecipientInput,
  type CreateMailboxMessageInput,
} from '../modules/messages';
import { getUserRoleIds, prepareCreateAuditEvent } from '../modules/admin';
import { buildAppContext } from '../app-context';
import { evaluateInboundPolicy } from '../modules/inbound-mail';
import { systemIds } from '../platform/ids';
import { getObjectStore } from '../platform/object-store';

const UNKNOWN_RECIPIENT_REASON = 'Unknown recipient. No mailbox found for this address.';

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // Check if this is a smoke test message during setup (CAP-013 backward compatibility)
    const handled = await handleSmokeTestMessage(message.to, env.CACHE);
    if (handled) return;

    // Parse the raw email
    const rawBytes = await new Response(message.raw).arrayBuffer();
    // Decode transfer encodings and nested multipart parts from the original
    // bytes. The raw RFC 5322 message is still preserved verbatim in R2.
    const { parsed, attachments } = await parseInboundMime(new Uint8Array(rawBytes));

    // To/Cc headers are sender-authored display data. Cloudflare invokes this
    // handler for the SMTP envelope recipient in message.to; only that address
    // is allowed to determine the mailbox that receives the message. This
    // also covers Bcc delivery, where the envelope address is absent from MIME.
    const mailbox = await findMailboxByAddress(env.DB, message.to);
    if (!mailbox) {
      await message.setReject(UNKNOWN_RECIPIENT_REASON);
      return;
    }

    // D-CAP-021 / CAP-035: evaluate blocklist + per-role policy before any
    // DB write. Architecture edge: inbound-mail reads admin-owned data via
    // contracts interfaces wired through app-context (composition root).
    const ctx = buildAppContext(env);
    const blocklistEntries = await ctx.blocklistReader.loadActiveBlocklistEntries();

    const ownerRoleIds = new Set(await getUserRoleIds(env.DB, mailbox.ownerUserId));
    const rolePolicies = await ctx.rolePolicyReader.loadRolePoliciesForRoleIds(
      Array.from(ownerRoleIds),
    );

    // Sender policies use Cloudflare's SMTP envelope sender. RFC From stays
    // intact in `parsed` for display and raw MIME evidence, but is a claim
    // controlled by the sender and cannot bypass ban/allow rules.
    const policyParsed = {
      ...parsed,
      from: { ...parsed.from, address: normalizeAddress(message.from) },
    };
    const decision = evaluateInboundPolicy(policyParsed, rolePolicies, blocklistEntries);
    if (!decision.allow) {
      // R-INBOUND-008: rejection short-circuits before any DB write
      // (no audit row either — Decision §Q4 OUT OF SCOPE).
      await message.setReject(decision.reason);
      return;
    }

    // Generate IDs for message and all related rows
    const messageId = systemIds.uuid();
    const rawObjectKey = `raw-mime/${messageId}`;
    const objectStore = getObjectStore(env);
    const writtenKeys: string[] = [];
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // CAP-040 / R-AUDIT-001: synthesise one correlation UUID for this
    // inbound message. Threaded through to the audit row so a reader of
    // audit_events can group all operations of one message together.
    const requestId = systemIds.uuid();

    // Prepare message statement
    const messageInput: CreateMessageInput = {
      id: messageId,
      parsed,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
      rawObjectKey,
    };

    // Prepare recipient statements (to + cc)
    const recipientStatements: D1PreparedStatement[] = [];
    const recipientInputs: CreateRecipientInput[] = [];

    for (const recipient of parsed.to) {
      const recipientId = systemIds.uuid();
      const recipientInput: CreateRecipientInput = {
        id: recipientId,
        messageId,
        address: recipient.address,
        displayName: recipient.name,
        type: 'to',
        createdAt: now,
      };
      recipientInputs.push(recipientInput);
      recipientStatements.push(prepareCreateRecipient(env.DB, recipientInput));
    }

    for (const recipient of parsed.cc) {
      const recipientId = systemIds.uuid();
      const recipientInput: CreateRecipientInput = {
        id: recipientId,
        messageId,
        address: recipient.address,
        displayName: recipient.name,
        type: 'cc',
        createdAt: now,
      };
      recipientInputs.push(recipientInput);
      recipientStatements.push(prepareCreateRecipient(env.DB, recipientInput));
    }

    const mailboxMessageInput: CreateMailboxMessageInput = {
      id: systemIds.uuid(),
      mailboxId: mailbox.id,
      messageId,
      createdAt: now,
    };
    const mailboxMessageStatement = prepareCreateMailboxMessage(env.DB, mailboxMessageInput);

    const attachmentStatements: D1PreparedStatement[] = [];
    const attachmentObjects: { key: string; content: Uint8Array }[] = [];
    for (const attachment of attachments) {
      const attachmentId = systemIds.uuid();
      const objectKey = `inbound-attachment/${messageId}/${attachmentId}`;
      const safeFilename = attachmentFilenameSchema.safeParse(
        attachment.filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 255),
      );
      const safeContentType = attachmentContentTypeSchema.safeParse(attachment.contentType);
      const contentId = attachment.contentId?.replace(/[\0\r\n]/g, '').slice(0, 255) || null;
      attachmentObjects.push({ key: objectKey, content: attachment.content });
      attachmentStatements.push(
        prepareCreateInboundAttachment(env.DB, {
          id: attachmentId,
          messageId,
          objectKey,
          filename: safeFilename.success ? safeFilename.data : 'attachment',
          contentType: safeContentType.success ? safeContentType.data : 'application/octet-stream',
          sizeBytes: attachment.content.byteLength,
          disposition: attachment.disposition,
          contentId,
          createdAt: now,
        }),
      );
    }

    // Execute all statements in one atomic batch (R-INBOUND-008 +
    // CAP-046 / D-CAP-046-B: the audit_events INSERT is folded into the
    // same batch so the message INSERT + recipients + mailbox_messages +
    // audit row land atomically. A crash between the business writes
    // and the audit row would violate R-AUDIT-001.)
    const messageStatement = prepareCreateMessage(env.DB, messageInput);
    const auditStatement = prepareCreateAuditEvent(env.DB, {
      id: systemIds.uuid(),
      actorUserId: null,
      action: 'message.receive',
      resourceType: 'message',
      resourceId: messageId,
      requestId,
      createdAt: now,
    });
    const allStatements = [
      messageStatement,
      ...recipientStatements,
      mailboxMessageStatement,
      ...attachmentStatements,
      auditStatement,
    ];

    try {
      writtenKeys.push(rawObjectKey);
      await objectStore.put(rawObjectKey, rawBytes);
      for (const attachment of attachmentObjects) {
        writtenKeys.push(attachment.key);
        await objectStore.put(attachment.key, attachment.content);
      }
      await createMessageWithRelations(env.DB, allStatements);
    } catch (error) {
      // R2 and D1 cannot share a transaction. A failed D1 batch leaves no
      // visible attachment rows; clean up the new opaque objects before the
      // Email Routing retry. A failed cleanup leaves only orphaned R2 bytes.
      await Promise.allSettled(writtenKeys.map((key) => objectStore.delete(key)));
      throw error;
    }
  },
};
