// cloudflare-dashboard-link use case — POST /api/v1/setup/cloudflare/dashboard-link.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// Returns an allowlisted Cloudflare dashboard URL so the operator can enable
// Email Routing. Does NOT advance the installation step — the operator hasn't
// verified yet. This is a navigation helper only.

/**
 * Cloudflare dashboard base URL. Allowlisted server-side to prevent open redirect.
 * TODO: construct account-specific deep link when account_id is available (system_settings).
 */
const CLOUDFLARE_DASHBOARD_URL = 'https://dash.cloudflare.com';

export interface CloudflareDashboardLinkResult {
  readonly url: string;
}

/**
 * Returns the Cloudflare dashboard URL.
 * The operator navigates to Email Routing from the dashboard.
 * No state change — this is a read-only navigation helper.
 */
export async function getCloudflareDashboardLink(): Promise<CloudflareDashboardLinkResult> {
  // Allowlisted URL — constructed server-side, not from user input (no open redirect).
  return { url: CLOUDFLARE_DASHBOARD_URL };
}
