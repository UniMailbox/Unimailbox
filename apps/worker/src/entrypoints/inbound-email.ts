// Inbound: forward external copy, validate envelope/size/policy synchronously, then durably receive.
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { handleSmokeTestMessage } from '../modules/onboarding';
import { normalizeAddress, parseInboundMime } from '@unimailbox/email-core';
import { emailAddressSchema } from '@unimailbox/contracts';
import { resolveInboundMailbox } from '../modules/tenancy';
import { getUserRoleIds } from '../modules/admin';
import { buildAppContext } from '../app-context';
import {
  evaluateInboundPolicy,
  readInboundBytes,
  InboundSizeError,
  acceptInboundReceipt,
  processInboundReceipt,
} from '../modules/inbound-mail';
import { systemIds } from '../platform/ids';
import { logger } from '../platform/logger';

const UNKNOWN_RECIPIENT_REASON = 'Unknown recipient. No mailbox found for this address.';

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // Check if this is a smoke test message during setup (CAP-013 backward compatibility)
    const handled = await handleSmokeTestMessage(message.to, env.CACHE);
    if (handled) return;

    // Preserve the previous domain-wide external copy, including mail that
    // local policy later rejects. Await forwarding before persistence so a
    // provider failure cannot silently discard the copy. A storage failure
    // after forwarding can produce another copy on an upstream retry.
    if (env.INBOUND_FORWARD_TO) {
      const destination = emailAddressSchema.safeParse(env.INBOUND_FORWARD_TO);
      const catchAll = emailAddressSchema.safeParse(env.INBOUND_CATCH_ALL_MAILBOX);
      if (!destination.success || !catchAll.success)
        throw new Error('Invalid inbound forwarding configuration.');
      const domain = normalizeAddress(catchAll.data).split('@')[1];
      if (normalizeAddress(destination.data).split('@')[1] === domain)
        throw new Error('Inbound forwarding destination must be external.');
      if (normalizeAddress(message.to).split('@')[1] === domain)
        await message.forward(destination.data);
    }

    // To/Cc headers are sender-authored display data. Cloudflare invokes this
    // handler for the SMTP envelope recipient in message.to; only that address
    // is allowed to determine the mailbox that receives the message. This
    // also covers Bcc delivery, where the envelope address is absent from MIME.
    const mailbox = await resolveInboundMailbox(env.DB, message.to, env.INBOUND_CATCH_ALL_MAILBOX);
    if (!mailbox) {
      await message.setReject(UNKNOWN_RECIPIENT_REASON);
      return;
    }

    let rawBytes: ArrayBuffer;
    try {
      rawBytes = await readInboundBytes(message.raw, message.rawSize);
    } catch (error) {
      if (!(error instanceof InboundSizeError)) throw error;
      message.setReject(error.message);
      return;
    }
    const mime = await parseInboundMime(new Uint8Array(rawBytes));
    const { parsed } = mime;

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

    const requestId = systemIds.uuid();
    const receiptId = await acceptInboundReceipt(ctx, {
      mailboxId: mailbox.id,
      from: message.from,
      to: message.to,
      raw: rawBytes,
      requestId,
    });
    // SMTP acceptance is safe once both raw bytes and the durable receipt exist.
    // Keep normal delivery immediate; Queue and Cron repair post-acceptance failure.
    try {
      const deferred = await processInboundReceipt(receiptId, ctx, mime);
      if (!deferred) return;
      await env.OUTBOUND.send({ kind: 'inbound', version: 1, receiptId }, deferred);
    } catch {
      // The five-minute receipt dispatcher repairs even a lost Queue enqueue.
      logger.warn(
        { event: 'inbound.recovery_pending', requestId },
        { code: 'INBOUND_RECOVERY_PENDING' },
      );
    }
  },
};
