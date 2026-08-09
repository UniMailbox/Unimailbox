import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// Validates migrations/0011_mvp_minimum.sql. The M1 cut neutralises the
// active side-effects of 0007 and 0009. Companion: 0010_mvp_minimum_seed.sql
// (issue #16, PR #32) handles the permission/role seeds, and issue #17
// trimmed the configuration_checkpoints seed inline in 0004.
//
// Note: `file_id` / `md5` / `created_via_schedule` columns are kept
// dormant on purpose — the migration avoids ALTER DROP COLUMN to
// sidestep ~17 callsite rewrites in apps/worker/src. M6 (#27) and M7
// (#28) re-introduce the runtime behaviour without further schema
// changes.
describe("0011_mvp_minimum", () => {
  beforeAll(async () => {
    // Apply once: the migrations test pool runs 0001..0011 in order, so
    // applying the full chain in a single bootstrap is the canonical
    // way to expose the post-0011 state for the assertions below.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it("drops the two attachment triggers from 0001", async () => {
    const triggers = await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND name IN (
         'validate_attachment_upload', 'consume_attachment_upload'
       )`,
    ).all<{ name: string }>();
    expect(triggers.results).toEqual([]);
  });

  it("drops the 0007 dead indexes that reference dormant columns", async () => {
    const indexes = await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'index' AND name IN (
         'idx_attachment_files_md5_size',
         'idx_message_attachments_md5'
       )`,
    ).all<{ name: string }>();
    expect(indexes.results).toEqual([]);
  });

  it("removes the MD5 backfill job enqueued by 0007", async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM maintenance_jobs
       WHERE job_key = 'attachment-md5-backfill'`,
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("leaves the attachment_files schema empty (🟡 preserved but unused)", async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM attachment_files",
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("keeps attachment_files schema even when empty (🟡 per blueprint)", async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_schema
       WHERE type = 'table' AND name = 'attachment_files'`,
    ).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
