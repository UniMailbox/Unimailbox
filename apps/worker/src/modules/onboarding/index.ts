// modules/onboarding — owner of installation_state, registration_keys.
// Exports: getSetupStatus, claimSetup — the installation-state use cases.
// The repository (getInstallationState, seedInstallationState) is private (D-CAP-006-C).

export { getSetupStatus } from './setup-status';
export { claimSetup } from './claim-setup';
