import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const runbook = readFileSync(
  new URL(
    "../../.skills/runbooks/attachment-storage-migration.md",
    import.meta.url,
  ),
  "utf8",
);
const deployment = readFileSync(
  new URL("../docs/operations/deployment.md", import.meta.url),
  "utf8",
);
const setupRecovery = readFileSync(
  new URL("../../.skills/runbooks/setup-recovery.md", import.meta.url),
  "utf8",
);
const defaultWrangler = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);
const r2Wrangler = readFileSync(
  new URL("../wrangler.r2.jsonc", import.meta.url),
  "utf8",
);
const runtimeConfig = readFileSync(
  new URL("../apps/worker/src/platform/config.ts", import.meta.url),
  "utf8",
);
const bootstrapAdmin = readFileSync(
  new URL("./bootstrap-admin.mjs", import.meta.url),
  "utf8",
);
const bootstrapLib = readFileSync(
  new URL("./bootstrap-lib.mjs", import.meta.url),
  "utf8",
);
const devVars = readFileSync(
  new URL("../.dev.vars.example", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("R2 operational commands", () => {
  it("keeps initial Cloudflare deployment separate from verified releases", () => {
    expect(packageJson.scripts.deploy).toBe("node scripts/initial-deploy.mjs");
    expect(packageJson.scripts["deployment:bootstrap"]).toBe(
      "node scripts/deployment-bootstrap.mjs",
    );
    expect(packageJson.scripts["release:production"]).toBe(
      "node scripts/release.mjs production",
    );
  });

  it("deploys production and preview explicitly", () => {
    expect(packageJson.scripts["deploy:r2"]).toBe(
      "pnpm deploy:r2:production && pnpm deploy:r2:preview",
    );
    expect(packageJson.scripts["deploy:r2:production"]).toContain('--env ""');
    expect(packageJson.scripts["deploy:r2:preview"]).toContain("--env preview");
    expect(packageJson.scripts["deploy:r2:dry-run"]).toBe(
      "node scripts/r2-dry-run.mjs",
    );
  });

  it("documents commands supported by pinned Wrangler", () => {
    expect(runbook).toContain("wrangler kv namespace list");
    expect(runbook).toContain("wrangler kv key list");
    expect(runbook).not.toMatch(/wrangler kv:/u);
    expect(runbook).not.toContain("wrangler r2 object list");
    expect(deployment).not.toMatch(/wrangler kv:/u);
  });

  it("documents the read fallback and sequential preview deployment accurately", () => {
    expect(runbook).toMatch(/R2 first and then falls back to\s+KV/u);
    expect(deployment).toContain("deploy:r2:preview");
    expect(deployment).not.toContain(
      "`pnpm deploy:r2` also deploys the preview environment",
    );
  });

  it("keeps version preview URLs enabled for release verification", () => {
    for (const config of [defaultWrangler, r2Wrangler]) {
      expect(config.match(/"preview_urls": true/gu)).toHaveLength(2);
    }
  });

  it("serves client-side routes through the SPA shell", () => {
    for (const config of [defaultWrangler, r2Wrangler]) {
      expect(config).toContain(
        '"not_found_handling": "single-page-application"',
      );
    }
  });

  it("uses administrator inputs only during explicit bootstrap", () => {
    expect(packageJson.scripts["bootstrap:admin"]).toBe(
      "node scripts/bootstrap-admin.mjs",
    );
    expect(`${bootstrapAdmin}\n${bootstrapLib}`).toContain(
      "INITIAL_ADMIN_EMAIL",
    );
    expect(`${bootstrapAdmin}\n${bootstrapLib}`).toContain(
      "INITIAL_ADMIN_PASSWORD",
    );
    expect(readme).toContain("INITIAL_ADMIN_EMAIL");
    expect(readme).toContain("INITIAL_ADMIN_PASSWORD");
    expect(deployment).toContain("--force-admin-password-reset");
    expect(setupRecovery).toContain("--force-admin-password-reset");
    expect(
      [defaultWrangler, r2Wrangler, runtimeConfig, devVars].join("\n"),
    ).not.toContain("INSTALLATION_TOKEN");
  });

  it("does not prompt for generated runtime secrets", () => {
    for (const config of [defaultWrangler, r2Wrangler]) {
      expect(config).not.toContain("secrets_store_secrets");
      expect(config).not.toContain("AUTH_SIGNING_KEY");
      expect(config).not.toContain("CREDENTIAL_ENCRYPTION_KEY");
    }
    expect(packageJson.cloudflare?.bindings).toBeUndefined();
  });

  it("keeps D1 and KV required while R2 stays optional", () => {
    expect(defaultWrangler).toContain('"binding": "DB"');
    expect(defaultWrangler).toContain('"binding": "KV"');
    expect(defaultWrangler).not.toContain('"binding": "ATTACHMENTS"');
    expect(r2Wrangler).toContain('"binding": "ATTACHMENTS"');
  });
});
