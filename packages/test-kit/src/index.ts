import {
  PERMISSION_KEYS,
  type PermissionKey,
  type Principal,
} from "@unimailbox/contracts";

/**
 * Test-only superset of every permission the worker currently understands.
 *
 * Production admin principals receive the 5-key MVP grant (see issue #14,
 * blueprint section 7.2 — verification gates — and PR #31). Once PR #31
 * lands, `ADMINISTRATOR_PERMISSIONS` will be exactly that set; today it
 * still aliases `PERMISSION_KEYS`. Either way, integration tests exercise
 * admin code paths beyond the MVP surface (e.g. `user.manage`,
 * `message.read_all`, `attachment.read`) and need the full key set. Use
 * this constant in tests so each one stays explicit about wanting full
 * powers, rather than re-deriving it via `new Set([...PERMISSION_KEYS])`
 * everywhere.
 */
export const TEST_ADMIN_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS;

export function createPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: "63f9c510-00c3-48b6-95f8-cda4ef3439f0",
    email: "member@example.com",
    permissions: new Set(TEST_ADMIN_PERMISSIONS),
    ...overrides,
  };
}

export function fixedClock(iso = "2026-07-27T00:00:00.000Z") {
  return {
    now: () => new Date(iso),
  };
}
