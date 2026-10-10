// setup-status use case — returns the installation state.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// On a fresh DB (no installation_state row), defaults to
// { status: 'setup', currentStep: 'claim' } — the first setup-wizard step.
// DB errors propagate to the caller (the setup gate catches them for
// fail-closed behaviour, R-SETUP-004).

import type { Database } from '../../platform/database';
import type { InstallationStateInfo } from '@unimailbox/contracts';
import { getInstallationState } from './installation-state-repository';

/**
 * Returns the installation state. On a fresh DB (no row), defaults to
 * { status: 'setup', currentStep: 'claim' } — the first setup-wizard step.
 *
 * DB errors propagate to the caller (the setup gate catches them for
 * fail-closed behaviour, R-SETUP-004).
 */
export async function getSetupStatus(db: Database): Promise<InstallationStateInfo> {
  const state = await getInstallationState(db);
  if (!state) {
    return { status: 'setup', currentStep: 'claim' };
  }
  return state;
}
