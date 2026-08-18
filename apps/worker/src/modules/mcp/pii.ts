/**
 * PII redaction utilities for MCP tool/resource output.
 *
 * Per the impl doc §2.6 and §5.2: every string the model sees from the data
 * plane MUST pass through `redactText` first, and any email body MUST be
 * wrapped with `wrapUntrustedEmail` so the model's prompt can clearly mark
 * the content as untrusted.
 *
 * Patterns (in order):
 *   1. Email addresses                              → [email]
 *   2. CN mobile phone numbers (11 digits, 1[3-9]…) → [phone-cn]
 *   3. Long digit runs (16-19) passing Luhn         → [card]
 *      (non-Luhn runs are left alone to avoid false positives on IDs,
 *      zip codes, etc.)
 *   4. CN resident ID (18 digits, last may be X)    → [id-cn]
 *   5. IPv4 addresses                               → [ip]
 *
 * The allow-list lets callers exempt specific substrings (e.g. the agent's
 * own canonical address so its replies can be quoted without being redacted).
 */

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const PHONE_CN_PATTERN = /\b1[3-9]\d{9}\b/gu;
const LONG_DIGITS_PATTERN = /\b\d{16,19}\b/gu;
const ID_CN_PATTERN = /\b\d{17}[\dXx]\b/gu;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;

const REPLACEMENTS: Array<[RegExp, string]> = [
  [EMAIL_PATTERN, "[email]"],
  [PHONE_CN_PATTERN, "[phone-cn]"],
  [LONG_DIGITS_PATTERN, "[card]"],
  [ID_CN_PATTERN, "[id-cn]"],
  [IPV4_PATTERN, "[ip]"],
];

function luhnValid(rawDigits: string): boolean {
  const digits = rawDigits
    .split("")
    .reverse()
    .map((d) => Number.parseInt(d, 10));
  if (digits.some((d) => Number.isNaN(d))) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let value = digits[i];
    if (i % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  }
  return sum % 10 === 0;
}

/**
 * Apply the PII redaction patterns to a string. Matches against the
 * `allow` list are returned verbatim (so an agent can quote its own
 * principal address without scrubbing it).
 */
export function redactText(
  input: string,
  allow: readonly string[] = [],
): string {
  let result = input;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, (match) => {
      if (allow.includes(match)) return match;
      // Long-digit run: only redact when it passes the Luhn check, so
      // order numbers / IDs that happen to be 16-19 digits stay intact.
      if (pattern === LONG_DIGITS_PATTERN && !luhnValid(match)) return match;
      return replacement;
    });
  }
  return result;
}

/**
 * Wrap a chunk of email body in the standard sentinel pair so the
 * downstream model can identify untrusted content per the impl doc §5.2.
 *
 * The sentinels MUST be on their own lines so a downstream prompt parser
 * can split the body without ambiguity. Whitespace around the body is
 * preserved so callers that quote a precise slice do not lose context.
 */
export function wrapUntrustedEmail(body: string): string {
  return `BEGIN_UNTRUSTED_EMAIL\n${body}\nEND_UNTRUSTED_EMAIL`;
}
