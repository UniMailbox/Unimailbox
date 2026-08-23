// apps/worker/src/integrations/better-auth/path.ts — CAP-042 (AC 12).
//
// Single source of truth for the Better Auth `basePath`. Both the Hono
// router mount (`http/router.ts`) and the request-scoped Better Auth
// factory (`integrations/better-auth/factory.ts`) import this constant
// so the URL prefix can never drift between the two layers.
//
// AC 12 ("`/api/v1/auth/better/*` and Better Auth `basePath` match")
// is a *coincidence-of-strings* check between the route mount and the
// factory. Importing from a single module makes that coincidence a
// compile-time guarantee: a typo in either consumer becomes a
// "module not found" / type error rather than a silent 404.
//
// The path lives under `/api/v1/auth/better/*` rather than `/api/auth/*`
// because the existing CAP-019 routes already mount at
// `/api/v1/auth/*` (register, login, refresh, me). Suffixing with
// `/better/` keeps the Better Auth surface non-conflicting with the
// legacy issuance route and lets both run in `dual` mode (AC 12) while
// the cutover to `better-auth` is local-only.
export const BETTER_AUTH_BASE_PATH = '/api/v1/auth/better';

// Cookie name Better Auth uses when `cookiePrefix: 'unimailbox'` is
// configured. We only consume this in middleware (the route layer
// forwards raw requests and never inspects the cookie itself), but
// exposing the canonical name lets tests assert against the same
// string the browser receives — `Set-Cookie: unimailbox.session_token=…`.
//
// `cookiePrefix: 'unimailbox'` produces a single cookie named
// `<prefix>.session_token`. Better Auth does not split the prefix
// into a subdomain namespace; cross-subdomain cookies are explicitly
// rejected in spike-evidence.md §Cookie, origin, secret, and runtime
// decisions because the Worker + SPA share a host.
export const BETTER_AUTH_COOKIE_NAME = 'unimailbox.session_token';
