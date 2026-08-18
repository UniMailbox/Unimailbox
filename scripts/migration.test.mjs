import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runMigrationScenario({
  command = "migrate",
  target = "production",
  migrationTablePresent = 1,
  applicationSchemaPresent = 0,
  initialMigrationCount = 0,
  invalidStateJson = false,
  requireImport = false,
  verifyFailure = false,
  verifyUseFile = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "unimailbox-migration-"));
  const fakePnpm = join(directory, "pnpm");
  const commandLog = join(directory, "commands.jsonl");
  const bootstrapState = join(directory, "initial-schema-imported");
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(args) + "\\n");
const has = (value) => args.includes(value);
if (has("execute") && has("--command")) {
  const sql = args[args.indexOf("--command") + 1];
  if (sql.includes("migration_table_present")) {
    if (process.env.FAKE_INVALID_STATE_JSON === "1") {
      process.stdout.write("not-json");
    } else {
      process.stdout.write(JSON.stringify([{
        success: true,
        results: [{
          migration_table_present: Number(process.env.FAKE_MIGRATION_TABLE_PRESENT),
          application_schema_present: Number(process.env.FAKE_APPLICATION_SCHEMA_PRESENT)
        }]
      }]));
    }
    process.exit(0);
  }
  if (sql.includes("initial_migration_count")) {
    process.stdout.write(JSON.stringify([{
      success: true,
      results: [{
        initial_migration_count: Number(process.env.FAKE_INITIAL_MIGRATION_COUNT)
      }]
    }]));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify([
    { success: true, results: [{ migration_verified: 1 }] },
    { success: true, results: [] }
  ]));
  process.exit(0);
}
if (has("execute") && has("--file")) {
  const file = args[args.indexOf("--file") + 1];
  const sql = fs.readFileSync(file, "utf8");
  if (process.env.FAKE_VERIFY_USE_FILE === "1") {
    if (process.env.FAKE_VERIFY_FAILURE === "1") {
      process.stdout.write(JSON.stringify([
        { success: true, results: [{ migration_verified: 0 }] },
        { success: true, results: [] }
      ]));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify([
      { success: true, results: [{ migration_verified: 1 }] },
      { success: true, results: [] }
    ]));
    process.exit(0);
  }
  if (!sql.includes("CREATE TABLE users")) process.exit(31);
  if (!sql.includes("CREATE TABLE IF NOT EXISTS d1_migrations")) process.exit(32);
  if (!sql.includes("0001_initial.sql")) process.exit(33);
  fs.writeFileSync(process.env.FAKE_BOOTSTRAP_STATE, file);
  process.exit(0);
}
if (has("migrations") && has("apply")) {
  const importRequired = process.env.FAKE_REQUIRE_IMPORT === "1";
  process.exit(!importRequired || fs.existsSync(process.env.FAKE_BOOTSTRAP_STATE) ? 0 : 34);
}
process.stderr.write("Unexpected fake pnpm command: " + args.join(" "));
process.exit(35);
`,
  );
  chmodSync(fakePnpm, 0o700);

  const commandArgs = ["scripts/migration.mjs", command, "--target", target];
  if (command === "migrate" && target === "production") {
    commandArgs.push("--confirm", "deployment-123");
  }
  const result = spawnSync("node", commandArgs, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_APPLICATION_SCHEMA_PRESENT: String(applicationSchemaPresent),
      FAKE_BOOTSTRAP_STATE: bootstrapState,
      FAKE_COMMAND_LOG: commandLog,
      FAKE_INITIAL_MIGRATION_COUNT: String(initialMigrationCount),
      FAKE_INVALID_STATE_JSON: invalidStateJson ? "1" : "0",
      FAKE_MIGRATION_TABLE_PRESENT: String(migrationTablePresent),
      FAKE_REQUIRE_IMPORT: requireImport ? "1" : "0",
      FAKE_VERIFY_FAILURE: verifyFailure ? "1" : "0",
      FAKE_VERIFY_USE_FILE: verifyUseFile ? "1" : "0",
    },
  });
  const commands = existsSync(commandLog)
    ? readFileSync(commandLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return {
    bootstrapState,
    commands,
    directory,
    result,
  };
}

function cleanupScenario(scenario) {
  rmSync(scenario.directory, { recursive: true, force: true });
}

describe("remote migration bootstrap", () => {
  it("executes verification SQL as remote file imports so Wrangler returns assertion rows", () => {
    const verifyPath = resolve(
      import.meta.dirname,
      "..",
      "migrations",
      "meta",
      "0009_outbound_jobs_scheduled_origin.verify.sql",
    );
    const originalVerifySql = readFileSync(verifyPath, "utf8");
    writeFileSync(
      verifyPath,
      "SELECT 1 AS migration_verified;\nPRAGMA foreign_key_check;\n",
    );
    let scenario;
    try {
      scenario = runMigrationScenario({
        command: "verify",
        verifyUseFile: true,
      });
      expect(
        scenario.result.status,
        scenario.result.stderr || scenario.result.stdout,
      ).toBe(0);
      const verificationCount = readdirSync(
        resolve(import.meta.dirname, "..", "migrations", "meta"),
      ).filter((file) => file.endsWith(".verify.sql")).length;
      expect(scenario.commands).toHaveLength(verificationCount);
      for (const args of scenario.commands) {
        expect(args).toContain("--file");
        expect(args).not.toContain("--command");
        expect(args).toContain("--remote");
      }
    } finally {
      writeFileSync(verifyPath, originalVerifySql);
      if (scenario) cleanupScenario(scenario);
    }
  });

  it("refuses a verify SQL whose first non-empty line is a SQL line comment", () => {
    const verifyPath = resolve(
      import.meta.dirname,
      "..",
      "migrations",
      "meta",
      "0009_outbound_jobs_scheduled_origin.verify.sql",
    );
    const originalVerifySql = readFileSync(verifyPath, "utf8");
    writeFileSync(
      verifyPath,
      "-- intentionally leading SQL line comment\nSELECT 1 AS migration_verified;\nPRAGMA foreign_key_check;\n",
    );
    let scenario;
    try {
      scenario = runMigrationScenario({
        command: "verify",
        verifyUseFile: true,
      });
      expect(scenario.result.status).toBe(9);
      expect(scenario.result.stdout).toContain(
        '"event":"migration.verify_comment_prefix"',
      );
      expect(scenario.result.stdout).toContain(
        "starts with a SQL line comment",
      );
    } finally {
      writeFileSync(verifyPath, originalVerifySql);
      if (scenario) cleanupScenario(scenario);
    }
  });

  it("treats a multi-statement verify SQL with SELECT and PRAGMA as valid", () => {
    const verifyPath = resolve(
      import.meta.dirname,
      "..",
      "migrations",
      "meta",
      "0009_outbound_jobs_scheduled_origin.verify.sql",
    );
    const originalVerifySql = readFileSync(verifyPath, "utf8");
    writeFileSync(
      verifyPath,
      "SELECT 1 AS migration_verified;\nPRAGMA foreign_key_check;\n",
    );
    let scenario;
    try {
      scenario = runMigrationScenario({
        command: "verify",
        verifyUseFile: true,
      });
      expect(
        scenario.result.status,
        scenario.result.stderr || scenario.result.stdout,
      ).toBe(0);
      expect(scenario.result.stdout).toContain(
        '"event":"migration.verify.completed"',
      );
      for (const args of scenario.commands) {
        expect(args).toContain("--file");
        expect(args).toContain("--json");
        expect(args).toContain("--remote");
        expect(args).not.toContain("--command");
      }
    } finally {
      writeFileSync(verifyPath, originalVerifySql);
      if (scenario) cleanupScenario(scenario);
    }
  });

  it("surfaces migration.verify_assertion_failed when D1 reports a zero assertion row", () => {
    const verifyPath = resolve(
      import.meta.dirname,
      "..",
      "migrations",
      "meta",
      "0009_outbound_jobs_scheduled_origin.verify.sql",
    );
    const originalVerifySql = readFileSync(verifyPath, "utf8");
    writeFileSync(
      verifyPath,
      "SELECT 1 AS migration_verified;\nPRAGMA foreign_key_check;\n",
    );
    let scenario;
    try {
      scenario = runMigrationScenario({
        command: "verify",
        verifyUseFile: true,
        verifyFailure: true,
      });
      expect(scenario.result.status).toBe(6);
      expect(scenario.result.stdout).toContain(
        '"event":"migration.verify_assertion_failed"',
      );
    } finally {
      writeFileSync(verifyPath, originalVerifySql);
      if (scenario) cleanupScenario(scenario);
    }
  });

  it("imports an untracked initial schema atomically before applying later migrations", () => {
    const scenario = runMigrationScenario({ requireImport: true });
    try {
      expect(
        scenario.result.status,
        scenario.result.stderr || scenario.result.stdout,
      ).toBe(0);
      const imported = scenario.commands.find(
        (args) => args.includes("execute") && args.includes("--file"),
      );
      expect(imported).toBeDefined();
      expect(imported).toContain("--remote");
      expect(scenario.commands.at(-1)).toEqual([
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--remote",
      ]);
      const temporaryPath = readFileSync(scenario.bootstrapState, "utf8");
      expect(() => readFileSync(temporaryPath)).toThrow();
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("leaves an already recorded initial migration on the standard path", () => {
    const scenario = runMigrationScenario({ initialMigrationCount: 1 });
    try {
      expect(
        scenario.result.status,
        scenario.result.stderr || scenario.result.stdout,
      ).toBe(0);
      expect(
        scenario.commands.some(
          (args) => args.includes("execute") && args.includes("--file"),
        ),
      ).toBe(false);
      expect(scenario.commands.at(-1)).toContain("apply");
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("refuses to overwrite an application schema missing migration history", () => {
    const scenario = runMigrationScenario({
      applicationSchemaPresent: 1,
      migrationTablePresent: 0,
    });
    try {
      expect(scenario.result.status).toBe(8);
      expect(scenario.result.stdout).toContain(
        '"event":"migration.initial_schema_untracked"',
      );
      expect(
        scenario.commands.some(
          (args) => args.includes("--file") || args.includes("apply"),
        ),
      ).toBe(false);
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("fails closed when D1 returns malformed schema state", () => {
    const scenario = runMigrationScenario({ invalidStateJson: true });
    try {
      expect(scenario.result.status).toBe(5);
      expect(scenario.result.stdout).toContain(
        '"event":"migration.initial_schema_state_invalid"',
      );
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("keeps local migrations on Wrangler's standard apply path", () => {
    const scenario = runMigrationScenario({ target: "local" });
    try {
      expect(
        scenario.result.status,
        scenario.result.stderr || scenario.result.stdout,
      ).toBe(0);
      expect(scenario.commands).toEqual([
        ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local"],
      ]);
    } finally {
      cleanupScenario(scenario);
    }
  });
});
