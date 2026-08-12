/**
 * @unimailbox/email-core
 *
 * Pure RFC 5322 functions. No I/O, no Date.now(), no crypto. Deterministic.
 *
 * CAP-001 lays rails — this skeleton exports nothing yet. Real parsing /
 * serialization lands with the inbound-mail capability (Phase 1).
 *
 * `normalizeAddress` is a single trivial pure helper added in CAP-002 so the
 * test harness has a public function to exercise. The full RFC 5322 parser
 * (header unfolding, address-list parsing, etc.) lands with CAP-021.
 */

/**
 * Lowercases and trims an email address — R-DATA-001 (email addresses are
 * compared and stored case-insensitively). Pure: no I/O, no `Date.now()`,
 * no `crypto.randomUUID()`. The full RFC 5322 normalisation lands with
 * CAP-021 (inbound-mail).
 */
export function normalizeAddress(input: string): string {
  return input.trim().toLowerCase();
}