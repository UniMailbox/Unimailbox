# 0012 mcp attachment download flag

- Purpose: add a default-off `mcp_attachment_download_enabled` column to `system_settings` so the first-party MCP `download_attachment` tool stays fail-closed until the user opts in. PR #5 of 8 in the email-mcp-server rollout.
- Compatibility window: column is new and has no readers yet; existing MCP tools keep their previous behaviour. The dispatcher in `apps/worker/src/modules/mcp/tools/attachment-tools.ts` checks the flag and throws `McpToolError("forbidden")` when it is not set.
- Expected duration: instant.
- Backfill: none — the default value is 0 (off).
- Verification: `migrations/meta/0012_mcp_attachment_download_flag.verify.sql` returns one row.
- Recovery: the column is purely a feature flag. Operators can flip it via `UPDATE system_settings SET mcp_attachment_download_enabled = 1 WHERE id = 1`; revert by setting it back to 0. No persistent state depends on the column.
