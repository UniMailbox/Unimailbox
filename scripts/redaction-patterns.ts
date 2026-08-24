// scripts/redaction-patterns.ts — CAP-045 HIGH 1 fix. Exported so unit
// tests can assert the patterns reject synthetic secrets AND accept
// benign production diagnostics (the false-positive target was
// `[preflight] secret read failed`, which must NOT match).
//
// Patterns are anchored to value-bearing forms (`key: <v>`, `key=<v>`,
// underscored field names). Generic substring matches (`/secret/`) are
// rejected at the design level because production code uses "secret" in
// many legitimate places — function names, log strings, diagnostic
// messages. A redaction tool that trips on benign production strings is
// not a redaction tool.

export const FORBIDDEN_LOG_PATTERNS: ReadonlyArray<RegExp> = [
  // password / hash / salt — covers token name OR value-bearing form.
  /(password_hash|password_salt|password_iterations|password\s*[:=]|password_hash\s*[:=])/i,
  // hash field names — generic `hash:` only flags value-bearing form.
  /(password_hash|hash_value|sha256.*body|hash\s*[:=]\s*\w{20,})/i,
  // secret / webhook_secret / API key — same anchoring rule.
  /(secret\s*[:=]\s*\w+|webhook_secret\b|api[_-]?key\s*[:=])/i,
  // credential / encrypted_credential — value-bearing form OR bare field name.
  /(credential\s*[:=]|credential_id|encrypted_credential\b)/i,
  // token / access_token / refresh_token / idempotency_key.
  /(access_token|refresh_token|idempotency[_-]?key\b|token\s*[:=]\s*\w{16,})/i,
  // in-reply-to / references / body fields — `body=` form only.
  /(in[_-]?reply[_-]?to\b|inReplyTo\b|references\s*[:=]\s*[\w<]|message[_-]?body|email[_-]?body|request[_-]?body\s*[:=])/i,
  // cookies.
  /(cookie\s*[:=]|set-cookie\b)/i,
];
