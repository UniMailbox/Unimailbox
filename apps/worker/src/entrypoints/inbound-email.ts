// Inbound-email entry — Email Routing handler.
// CAP-021: Real inbound mail processing with MIME parsing.
//
// Flow:
// 1. Check if this is a smoke test message (CAP-013 backward compatibility)
// 2. Read raw email stream
// 3. Parse MIME headers and body
// 4. For each recipient address, find mailbox
// 5. If mailbox found: create message + recipients + mailbox_messages in one D1 batch
// 6. If no mailbox found: reject (unknown recipient)
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
// R-DATA-001: Email addresses are case-insensitive

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
    const foundMailboxes: Array<{ id: string; address: string }> = [];
    for (const address of recipientAddresses) {
      const mailbox = await findMailboxByAddress(env.DB, address);
      if (mailbox) {
        foundMailboxes.push({ id: mailbox.id, address });
      }
    }

    // If no mailbox found for any recipient, reject
    if (foundMailboxes.length === 0) {
      await message.setReject(UNKNOWN_RECIPIENT_REASON);
      return;
    }

    // Generate IDs for message and all related rows
    const messageId = systemIds.uuid();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

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
    const allStatements = [
      messageStatement,
      ...recipientStatements,
      ...mailboxMessageStatements,
    ];

    await createMessageWithRelations(env.DB, allStatements);
  },
};
