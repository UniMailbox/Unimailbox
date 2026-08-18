# 0010 agent tokens

- Purpose: add the `agent_tokens` table to back the first-party MCP server's long-lived, scope-restricted bearer tokens. Tokens are PBKDF2 hashed and revocable; scopes are persisted as a JSON-encoded subset of `PERMISSION_KEYS`.
- Compatibility window: the table is new and has no readers yet — Workers continue to behave identically. Existing JWT-based authentication remains the only authentication surface until later MCP PRs land.
- Expected duration: instant.
- Backfill: none.
- Verification: `migrations/meta/0010_agent_tokens.verify.sql` returns one row.
- Recovery: drop the table once no Workers read it; never edit this file after release.
