// Inbound-email entry — Email Routing handler.
// CAP-021: Real inbound mail processing with MIME parsing.
// D-CAP-021 / CAP-035: Blocklist + per-role policy evaluation before
// persistence.
//
// Flow:
// 1. Check if this is a smoke test message (CAP-013 backward compatibility)
// 2. Read raw email stream
// 3. Parse MIME headers and body
// 4. For each recipient address, find mailbox
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
import { parseEmail } from '@unimailbox/email-core';
import { findMailboxByAddress } from '../modules/tenancy';
import {
  prepareCreateMessage,
  prepareCreateRecipient,
  prepareCreateMailboxMessage,
  createMessageWithRelations,
  type CreateMessageInput,
  type CreateRecipientInput,
  type CreateMailboxMessageInput,
} from '../modules/messages';
import { createAuditEvent, getUserRoleIds } from '../modules/admin';
import { buildAppContext } from '../app-context';
import { evaluateInboundPolicy } from '../modules/inbound-mail';
import { systemIds } from '../platform/ids';

const UNKNOWN_RECIPIENT_REASON = 'Unknown recipient. No mailbox found for this address.';

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // Check if this is a smoke test message during setup (CAP-013 backward compatibility)
    const handled = await handleSmokeTestMessage(message.to, env.CACHE);
    if (handled) return;

    // Parse the raw email
    const rawEmail = await new Response(message.raw).text();

    // Parse MIME headers and body
    const parsed = await parseEmail(rawEmail);

    // Collect all unique recipient addresses (to + cc)
    const recipientAddresses = new Set<string>();
    for (const recipient of parsed.to) {
      recipientAddresses.add(recipient.address);
    }
    for (const recipient of parsed.cc) {
      recipientAddresses.add(recipient.address);
    }

    // Find mailboxes for each recipient address
    const foundMailboxes: Array<{ id: string; address: string; ownerUserId: string }> = [];
    for (const address of recipientAddresses) {
      const mailbox = await findMailboxByAddress(env.DB, address);
      if (mailbox) {
        foundMailboxes.push({ id: mailbox.id, address, ownerUserId: mailbox.ownerUserId });
      }
    }

    // If no mailbox found for any recipient, reject
    if (foundMailboxes.length === 0) {
      await message.setReject(UNKNOWN_RECIPIENT_REASON);
      return;
    }

    // D-CAP-021 / CAP-035: evaluate blocklist + per-role policy before any
    // DB write. Architecture edge: inbound-mail reads admin-owned data via
    // contracts interfaces wired through app-context (composition root).
    const ctx = buildAppContext(env);
    const blocklistEntries = await ctx.blocklistReader.loadActiveBlocklistEntries();

    // Collect unique role IDs across all recipient mailbox owners.
    // Set semantics avoid loading the same policy row twice when multiple
    // recipient mailboxes share an owner.
    const ownerRoleIds = new Set<string>();
    for (const mailbox of foundMailboxes) {
      const roleIds = await getUserRoleIds(env.DB, mailbox.ownerUserId);
      for (const roleId of roleIds) ownerRoleIds.add(roleId);
    }
    const rolePolicies = await ctx.rolePolicyReader.loadRolePoliciesForRoleIds(
      Array.from(ownerRoleIds),
    );

    const decision = evaluateInboundPolicy(parsed, rolePolicies, blocklistEntries);
    if (!decision.allow) {
      // R-INBOUND-008: rejection short-circuits before any DB write
      // (no audit row either — Decision §Q4 OUT OF SCOPE).
      await message.setReject(decision.reason);
      return;
    }

    // Generate IDs for message and all related rows
    const messageId = systemIds.uuid();
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

    // Prepare mailbox_message statements (one per found mailbox)
    const mailboxMessageStatements: D1PreparedStatement[] = [];
    for (const mailbox of foundMailboxes) {
      const mailboxMessageId = systemIds.uuid();
      const mailboxMessageInput: CreateMailboxMessageInput = {
        id: mailboxMessageId,
        mailboxId: mailbox.id,
        messageId,
        createdAt: now,
      };
      mailboxMessageStatements.push(prepareCreateMailboxMessage(env.DB, mailboxMessageInput));
    }

    // Execute all statements in one atomic batch (R-INBOUND-008)
    const messageStatement = prepareCreateMessage(env.DB, messageInput);
    const allStatements = [messageStatement, ...recipientStatements, ...mailboxMessageStatements];

    await createMessageWithRelations(env.DB, allStatements);

    // R-AUDIT-001: record the state transition.
    await createAuditEvent(env.DB, {
      id: systemIds.uuid(),
      actorUserId: null,
      action: 'message.receive',
      resourceType: 'message',
      resourceId: messageId,
      requestId,
      createdAt: now,
    });
  },
};
