// apps/worker/src/integrations/better-auth/schema.ts — CAP-042 (AC 12).
//
// Composes the Drizzle adapter schema that Better Auth's `drizzleAdapter`
// receives. The factory (`integrations/better-auth/factory.ts`) is the
// only consumer; the HTTP layer never imports this directly.
//
// CAP-042 keeps the canonical `users` table as the source of truth
// (spike-evidence.md §Generated SQLite schema comparison). The Better
// Auth logical model `user` therefore maps to the same physical
// `users` table, with `name` ↔ `display_name` and `email_verified`
// + `image` columns added by `migrations/0014_better_auth_substrate.sql`.
// The Drizzle declaration `apps/worker/src/database/schema/identity.ts`
// is the typing surface; the SQL migration is the deployable artifact.
//
// Auth-only tables (`auth_accounts`, `auth_sessions`,
// `auth_verifications`) are typed in the same schema module and were
// added by the same 0014 migration. Better Auth does **not** write to
// `users` — `emailAndPassword.disableSignUp: true` in the factory and
// the registration test in `integrations/better-auth/` together prove
// the application's registration is the only user-creation surface.
import { authAccounts, authSessions, authVerifications, users } from '../../database/schema';

/**
 * Better Auth logical-model → Drizzle-schema mapping.
 *
 * `as const` preserves the narrow literal types so the Drizzle
 * adapter's internal `InferDBFieldsFromOptions` produces the expected
 * `additionalFields` shape. A `Schema = typeof schema` declaration on
 * the adapter call (see `factory.ts`) is the link that prevents a
 * future drift between this file and the SQL migration.
 */
export const betterAuthSchema = {
  user: users,
  account: authAccounts,
  session: authSessions,
  verification: authVerifications,
} as const;
