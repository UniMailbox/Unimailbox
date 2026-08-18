-- PR #5 first-party MCP: add the `mcp_attachment_download_enabled` flag
-- to `system_settings`. The flag is the default-off guard behind the
-- `download_attachment` MCP tool — even with the `attachment.read` scope
-- granted, the tool returns `McpToolError("forbidden")` when this flag
-- is not flipped on by the user. `list_attachments` does not depend on
-- it (metadata-only exposure is always on).
--
-- Defaults to 0 (off) so the tool stays fail-closed the moment it ships.
ALTER TABLE system_settings
  ADD COLUMN mcp_attachment_download_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (mcp_attachment_download_enabled IN (0, 1));
