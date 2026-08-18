import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const stylesPath = resolve(here, "..", "apps", "web", "src", "styles.css");

/**
 * Find CSS literal colours sitting inside a `:root { ... }` declaration vs.
 * the rest of the file. Selector-level literals are the failure mode this
 * guard exists to prevent — they should be replaced with semantic tokens.
 */
function partitionRootBlock(source) {
  const startToken = ":root";
  const lines = source.split("\n");
  const out = { inRoot: [], outsideRoot: [] };
  let inRoot = false;
  let depth = 0;
  for (const [index, line] of lines.entries()) {
    if (!inRoot && line.includes(startToken) && line.includes("{")) {
      inRoot = true;
      depth = 1;
      out.inRoot.push({ index: index + 1, line });
      continue;
    }
    if (inRoot) {
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      out.inRoot.push({ index: index + 1, line });
      if (depth <= 0) inRoot = false;
      continue;
    }
    out.outsideRoot.push({ index: index + 1, line });
  }
  return out;
}

describe("styles.css colour tokens", () => {
  const source = readFileSync(stylesPath, "utf8");

  it("keeps hard-coded colour literals inside :root declarations only", () => {
    const { outsideRoot } = partitionRootBlock(source);
    const offenders = outsideRoot.filter(({ line }) =>
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(line),
    );
    const renderable = offenders
      .filter(({ line }) => !/^\s*\/\*|\/\//.test(line))
      .map(({ index, line }) => `${index}: ${line.trim()}`);
    expect(renderable, renderable.join("\n")).toEqual([]);
  });

  it("declares every var(--token) referenced in the file", () => {
    const declared = new Set();
    for (const match of source.matchAll(/^\s*--([a-zA-Z][\w-]*)\s*:/gmu)) {
      declared.add(match[1]);
    }
    const used = new Set();
    for (const match of source.matchAll(/var\(\s*--([a-zA-Z][\w-]*)\s*\)/gu)) {
      used.add(match[1]);
    }
    // Tokens provided at runtime by Radix / shadcn are exempt from the
    // declaration check — we only care about tokens the stylesheet itself owns.
    const externalAllowList = new Set(["radix-popover-trigger-width"]);
    const missing = [...used]
      .filter((token) => !declared.has(token) && !externalAllowList.has(token))
      .sort();
    expect(missing, missing.join(", ")).toEqual([]);
  });
});
