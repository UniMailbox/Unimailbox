#!/usr/bin/env node
// Idempotently create the Vectorize index used by the first-party MCP server's
// semantic search pipeline. Tolerates "already exists" so it is safe to re-run.
//
// Usage:
//   node scripts/vectorize-bootstrap.mjs
//   VECTORIZE_INDEX=unimailbox-preview-messages node scripts/vectorize-bootstrap.mjs
//
// Override the index name with `VECTORIZE_INDEX=<name>`. To target a non-default
// Cloudflare account or environment, set `CLOUDFLARE_ACCOUNT_ID` /
// `CLOUDFLARE_ENV` — those are picked up by the underlying `wrangler` CLI
// without us having to forward argv.
import { tryCreateIndex } from "./vectorize-bootstrap-lib.mjs";

const indexName = process.env.VECTORIZE_INDEX ?? "unimailbox-messages";

const { created } = tryCreateIndex({ indexName });
if (created) {
  console.log(`Created Vectorize index '${indexName}' (768-dim, cosine).`);
} else {
  console.log(
    `Vectorize index '${indexName}' already exists — skipping creation.`,
  );
}
