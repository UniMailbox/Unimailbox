// modules/onboarding — owner of installation_state, registration_keys.
// Exports: getSetupStatus, claimSetup, runPreflight, createAdministrator, createDomainStep,
//   getCloudflareDashboardLink, verifyCloudflareEmailRouting, startInboundSmokeTest, checkInboundSmokeTest,
//   handleSmokeTestMessage, setupBrevo, runOutboundSmokeTest, completeSetup — the setup use cases.
// The repository (getInstallationState, seedInstallationState, updateInstallationStep) is private (D-CAP-006-C).
// Registration key repository is also exported (CAP-018).

export { getSetupStatus } from './setup-status';
export { claimSetup } from './claim-setup';
export { runPreflight } from './preflight';
export { createAdministrator } from './create-administrator';
export { createDomainStep } from './create-domain';
export { getCloudflareDashboardLink } from './cloudflare-dashboard-link';
export { verifyCloudflareEmailRouting } from './cloudflare-verify';
export {
  startInboundSmokeTest,
  checkInboundSmokeTest,
  handleSmokeTestMessage,
} from './inbound-smoke-test';
export { setupBrevo } from './setup-brevo';
export { runOutboundSmokeTest } from './outbound-smoke-test';
export { completeSetup } from './complete-setup';
export {
  createRegistrationKey,
  findKeyByCodeHash,
  prepareIncrementKeyUsage,
} from './registration-key-repository';
export { registerWithInvite } from './register-with-invite';
export type { CreateAdministratorInput, CreateAdministratorResult } from './create-administrator';
export type { CreateDomainInput, CreateDomainResult } from './create-domain';
export type { CloudflareDashboardLinkResult } from './cloudflare-dashboard-link';
export type { CloudflareVerifyInput, CloudflareVerifyResult } from './cloudflare-verify';
export type {
  StartSmokeTestInput,
  StartSmokeTestResult,
  CheckSmokeTestResult,
} from './inbound-smoke-test';
export type { SetupBrevoInput, SetupBrevoResult } from './setup-brevo';
export type { OutboundSmokeTestInput, OutboundSmokeTestResult } from './outbound-smoke-test';
export type { CompleteSetupInput, CompleteSetupResult } from './complete-setup';
export type { CreateRegistrationKeyInput, RegistrationKeyRow } from './registration-key-repository';
export type {
  RegisterWithInviteInput,
  RegisterWithInviteDeps,
  RegisterWithInviteResult,
} from './register-with-invite';
