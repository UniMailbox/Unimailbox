// modules/onboarding — owner of installation_state, registration_keys.
// Exports: getSetupStatus, claimSetup, runPreflight, createAdministrator, createDomainStep,
//   getCloudflareDashboardLink, verifyCloudflareEmailRouting — the setup use cases.
// The repository (getInstallationState, seedInstallationState, updateInstallationStep) is private (D-CAP-006-C).

export { getSetupStatus } from './setup-status';
export { claimSetup } from './claim-setup';
export { runPreflight } from './preflight';
export { createAdministrator } from './create-administrator';
export { createDomainStep } from './create-domain';
export { getCloudflareDashboardLink } from './cloudflare-dashboard-link';
export { verifyCloudflareEmailRouting } from './cloudflare-verify';
export type { CreateAdministratorInput, CreateAdministratorResult } from './create-administrator';
export type { CreateDomainInput, CreateDomainResult } from './create-domain';
export type { CloudflareDashboardLinkResult } from './cloudflare-dashboard-link';
export type { CloudflareVerifyInput, CloudflareVerifyResult } from './cloudflare-verify';
