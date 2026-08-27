// apps/web — auth session storage guard.
//
// CAP-042 (Batch 5) AC 21: no `localStorage`, `sessionStorage`, or
// `indexedDB` token write paths exist anywhere in
// `apps/web/src/features/auth/**`. CAP-043 Slice 3 fix H13 extends the
// guarded tree to `apps/web/src/features/mailbox/**` — the mailbox
// feature now owns session-adjacent surface (StarButton, delete dialog,
// query caches) and must not grow a second token-storage path either.
// This test walks BOTH source trees and asserts the absence of:
//
//   - `localStorage.<anything>` and `sessionStorage.<anything>` calls,
//   - any reference to `indexedDB` (better-auth / Dexie-style usage),
//   - the `persist` middleware on the Zustand store (it would otherwise
//     silently start writing to a chosen storage backend).
//
// A reviewer should be able to read this file and see exactly what
// shape of code would have violated the contract — every banned pattern
// has a named assertion below.
//
// Implementation note: `import.meta.glob` with `query: '?raw'` makes
// Vite return each matching file's text content at module load time,
// without requiring `node:fs`. This keeps the test portable across
// Node and happy-dom environments (the vitest project for `apps/web`
// runs in happy-dom).
import { describe, expect, it } from 'vitest';

// Glob the source trees relative to this file. Vite evaluates the globs
// at build time and produces a map from module path to file content.
// CAP-042 Batch 8 (L-1 fix): scan the whole subtree recursively
// (`./**/*.{ts,tsx}`) so guard coverage includes nested helpers, not
// only the files in this directory. CAP-043 Slice 3 fix H13 adds the
// sibling mailbox tree (`../mailbox/**/*.{ts,tsx}`). Test files are
// filtered out below.
const RAW_SOURCE: Readonly<Record<string, string>> = {
  ...import.meta.glob('./**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob('../mailbox/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

function authSourceFiles(): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const [filePath, content] of Object.entries(RAW_SOURCE)) {
    // Skip test files; the guard is about production code.
    if (filePath.endsWith('.test.ts') || filePath.endsWith('.test.tsx')) continue;
    entries.push([filePath, stripComments(content)]);
  }
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

// Strip both `//` line and `/* */` block comments before pattern-matching.
// Docstrings and module-level header comments legitimately name the
// forbidden tokens (e.g. "we never reference `indexedDB` here") without
// actually using them; the guard's job is to catch *code* paths, not
// documentation. We don't need a full TS parser — a token-level sweep
// that removes comments is enough to make the regex assertions
// meaningful.
function stripComments(source: string): string {
  // Block comments first so the line-comment pass doesn't break them.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutLines = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  // String literals can also contain `indexedDB`/`localStorage` as
  // substrings; we still want those flagged because they would be a
  // real write path at runtime. Leave string literals intact.
  return withoutLines;
}

describe('auth-session-storage guard (AC 21)', () => {
  it('features/auth/** and features/mailbox/** contain no localStorage/sessionStorage/indexedDB/persist references', () => {
    const files = authSourceFiles();
    // Sanity: this test is meaningful only if BOTH guarded trees have at
    // least one production file.
    const authFiles = files.filter(([filePath]) => !filePath.startsWith('../mailbox'));
    const mailboxFiles = files.filter(([filePath]) => filePath.startsWith('../mailbox'));
    expect(authFiles.length).toBeGreaterThan(0);
    expect(mailboxFiles.length).toBeGreaterThan(0);
    for (const [filePath, content] of files) {
      expect(content, `${filePath} should not use localStorage`).not.toMatch(/\blocalStorage\./i);
      expect(content, `${filePath} should not use sessionStorage`).not.toMatch(
        /\bsessionStorage\./i,
      );
      expect(content, `${filePath} should not reference indexedDB`).not.toMatch(/\bindexedDB\b/i);
      // Zustand's persist middleware is keyed by a `persist:` option
      // or a `persist(...)` call. Match both.
      expect(content, `${filePath} should not use Zustand persist middleware`).not.toMatch(
        /\bpersist\s*[:(]/,
      );
    }
  });
});
