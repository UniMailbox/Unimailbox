// modules/onboarding — owner of installation_state, registration_keys.
// Exports: getSetupStatus, claimSetup, runPreflight — the setup use cases.
// The repository (getInstallationState, seedInstallationState) is private (D-CAP-006-C).

export { getSetupStatus } from './setup-status';
export { claimSetup } from './claim-setup';
export { runPreflight } from './preflight';
