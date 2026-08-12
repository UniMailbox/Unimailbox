// Inbound-email entry — Email Routing handler. CAP-001 stub.
// Real MIME parsing lands with the inbound-mail module (CAP-021).
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';

// CAP-001 stub — explicitly reject so the message is not consumed by a side
// effect. Once CAP-021 lands, this handler persists the message and runs the
// inbound state machine (R-INBOUND-008).
const REJECTION_REASON =
  'CAP-001 stub: inbound not yet enabled. Replacement lands with CAP-021.';

export default {
  async email(message: ForwardableEmailMessage): Promise<void> {
    await message.setReject(REJECTION_REASON);
  },
};