/**
 * @unimailbox/test-kit
 *
 * Shared test fixtures and helpers. Real builders / fake clocks / factories
 * land with CAP-002 (test harness). CAP-001 ships a single placeholder so
 * the build pipeline can resolve the package from any workspace member.
 */

/**
 * Returns a no-op async function. Useful as the seed of a builder until the
 * real test harness lands. Discouraged in production code — this exists to
 * prove the package boundary.
 */
export const placeholderHelper = async (): Promise<void> => {
  await Promise.resolve();
};

export {};