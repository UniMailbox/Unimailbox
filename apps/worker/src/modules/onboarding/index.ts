// modules/onboarding — owner of installation_state, registration_keys.
// Exports: getSetupStatus, claimSetup, runPreflight, createAdministrator — the setup use cases.
// The repository (getInstallationState, seedInstallationState, updateInstallationStep) is private (D-CAP-006-C).

export { getSetupStatus } from './setup-status';
export { claimSetup } from './claim-setup';
export { runPreflight } from './preflight';
export { createAdministrator } from './create-administrator';
export type { CreateAdministratorInput, CreateAdministratorResult } from './create-administrator';
