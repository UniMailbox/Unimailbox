// apps/web — setup feature public API.
// The router and App.tsx import from here; tests may import from specific
// files. Components and queries are private; only the layout + step
// components are re-exported for the router to mount.
export { SetupLayout } from './setup-layout';
export { ClaimStep } from './steps/ClaimStep';
export { PreflightStep } from './steps/PreflightStep';
export { AdministratorStep } from './steps/AdministratorStep';
export { DomainStep } from './steps/DomainStep';
export { CloudflareVerifyStep } from './steps/CloudflareVerifyStep';
export { InboundSmokeStep } from './steps/InboundSmokeStep';
export { BrevoStep } from './steps/BrevoStep';
export { OutboundSmokeStep } from './steps/OutboundSmokeStep';
export { CompleteStep } from './steps/CompleteStep';
export {
  useSetupSession,
  setSetupSession,
  clearSetupSession,
  resetSetupSessionForTesting,
} from './setup-session-store';
export type { SetupSessionStore } from './setup-session-store';
export {
  fetchSetupStatus,
  setupStatusQuery,
  fetchSetupPreflight,
  setupPreflightQuery,
  setupQueryKeys,
} from './setup-queries';
