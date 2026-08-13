// Inbound-email entry — Email Routing handler. CAP-001 stub.
// Real MIME parsing lands with the inbound-mail module (CAP-021).
//
// CAP-013: Accepts smoke test messages during setup. All other messages are rejected.
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { handleSmokeTestMessage } from '../modules/onboarding';

const REJECTION_REASON = 'Inbound email not yet enabled. Only smoke-test messages are accepted during setup.';

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // Check if this is a smoke test message during setup
    const handled = await handleSmokeTestMessage(message.to, env.CACHE);
    if (handled) return;

    // Not a smoke test — reject until full inbound processing lands (CAP-021)
    await message.setReject(REJECTION_REASON);
  },
};
