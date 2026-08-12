/**
 * @unimailbox/test-kit — shared fixtures and builders.
 *
 * Builders live here so test files don't copy-paste seed data
 * (.claude/rules/testing.md §Mocking). The shapes are intentionally minimal
 * — placeholders that tests extend with fields they need. Full row shapes
 * arrive with the capabilities that own those tables (CAP-004 etc.).
 *
 * The package does not import zod or any schema library. Builders produce
 * plain objects; tests cast to the row types their capability owns.
 *
 * Authorization note: per .claude/rules/security.md (R-AUTHZ-005), admin
 * identity comes from the `administrator` role in `user_roles`, NEVER from a
 * flag on the user row. Tests that need an admin actor call `fixtures.userRole`
 * separately, then resolve the user/role join themselves.
 */

export interface UserRowShape {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserRoleRowShape {
  userId: string;
  role: 'administrator' | 'member';
  grantedAt: string;
}

export interface InstallationStateRowShape {
  status: 'uninitialised' | 'in_progress' | 'complete';
  currentStep: string;
  claimedBy: string | null;
  updatedAt: string;
}

export type FixtureOverrides<T extends object> = Partial<T>;

/**
 * Builds a deterministic user row. `createdAt` and `updatedAt` come from the
 * supplied clock; the rest are constants. Tests pass overrides for fields
 * they care about (`{ id: 'user-1' }`, `{ email: 'admin@example.test' }`).
 *
 * Password storage is intentionally absent — the row shape lands with
 * CAP-004 (identity) per ADR-006 (algorithm, iterations, salt, hash).
 */
export function user(
  overrides: FixtureOverrides<UserRowShape> = {},
  clock: { now(): Date } = { now: (): Date => new Date('2026-01-01T00:00:00.000Z') },
): UserRowShape {
  const ts = clock.now().toISOString();
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'user@example.test',
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

/**
 * Builds a deterministic `user_roles` row. Joining this with a `fixtures.user`
 * yields an admin actor; per R-AUTHZ-005 the admin claim lives here, not on
 * the user row.
 */
export function userRole(
  overrides: FixtureOverrides<UserRoleRowShape> = {},
  clock: { now(): Date } = { now: (): Date => new Date('2026-01-01T00:00:00.000Z') },
): UserRoleRowShape {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    role: 'member',
    grantedAt: clock.now().toISOString(),
    ...overrides,
  };
}

/**
 * Builds a deterministic installation_state row. CAP-002 only proves the
 * fixture wiring; full row shape (admin email, claim expiry, etc.) lands
 * with CAP-008.
 */
export function installationState(
  overrides: FixtureOverrides<InstallationStateRowShape> = {},
  clock: { now(): Date } = { now: (): Date => new Date('2026-01-01T00:00:00.000Z') },
): InstallationStateRowShape {
  return {
    status: 'uninitialised',
    currentStep: 'preflight',
    claimedBy: null,
    updatedAt: clock.now().toISOString(),
    ...overrides,
  };
}

export const fixtures = {
  user,
  userRole,
  installationState,
} as const;
