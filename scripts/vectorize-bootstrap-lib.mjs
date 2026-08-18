// Pure helpers for vectorize-bootstrap.mjs, extracted so the "already exists"
// regex branch and the command-shape contract are unit-testable without
// invoking the real `wrangler` CLI.
//
// Used by:
//   - scripts/vectorize-bootstrap.mjs (CLI wrapper)
//   - scripts/vectorize-bootstrap.test.mjs (vitest)

import { execSync as defaultExecSync } from "node:child_process";

/**
 * Build the `wrangler vectorize create` command string for the given index
 * name. Always pins `--dimensions 768` and `--metric cosine` so the index
 * matches the `env.AI.run('@cf/baai/bge-base-en-v1.5', …)` embedding model
 * the first-party MCP server consumes.
 *
 * @param {string} indexName
 * @returns {string}
 */
export function buildWranglerCreateCommand(indexName) {
  return `wrangler vectorize create ${indexName} --dimensions 768 --metric cosine`;
}

/**
 * Try to create the Vectorize index. Returns `{ created: true }` when the
 * index was created, `{ created: false }` when it already existed. Re-throws
 * on any other failure.
 *
 * The `exec` argument defaults to `node:child_process.execSync` and is
 * injectable so tests can substitute a mock.
 *
 * @param {{
 *   indexName: string;
 *   exec?: (command: string, options: { stdio: "inherit" }) => void;
 * }} args
 */
export function tryCreateIndex({ indexName, exec = defaultExecSync }) {
  try {
    exec(buildWranglerCreateCommand(indexName), { stdio: "inherit" });
    return { created: true };
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (/already exists/i.test(message)) {
      return { created: false };
    }
    throw error;
  }
}
