// scripts/scaffold.test.ts — locks the arg-forwarding rules of the
// dispatcher in scripts/scaffold.ts.
//
// The dispatcher is intentionally thin: it routes subcommands and passes
// their flags through. The bug it once had was that
// `pnpm scaffold db:migrate --reset` silently dropped the `--reset`
// because the dedup filter `v !== '--reset'` ran on both the alias path
// (where the flag was prepended) and the explicit path (where the
// operator typed it). The runner saw no args, so the persist dir was
// never wiped and the command only verified. These cases pin the
// forwarding contract so a future refactor can't regress to a "looks
// fine, does nothing" reset.
import { describe, expect, it } from 'vitest';
import { forwardDbMigrateArgs } from './scaffold.js';

describe('scripts/scaffold.ts — forwardDbMigrateArgs', () => {
  describe('db:migrate (explicit subcommand)', () => {
    it('passes no flags when the operator passes no flags', () => {
      expect(forwardDbMigrateArgs('db:migrate', [])).toEqual([]);
    });

    it('passes --reset through unchanged (regression — was silently dropped)', () => {
      // The bug this test exists to catch: the old dispatcher filtered
      // `--reset` on the db:migrate path too. The runner then saw no
      // args and only verified, leaving the local D1 intact.
      expect(forwardDbMigrateArgs('db:migrate', ['--reset'])).toEqual(['--reset']);
    });

    it('passes --verify through unchanged', () => {
      expect(forwardDbMigrateArgs('db:migrate', ['--verify'])).toEqual(['--verify']);
    });

    it('preserves flag order when --reset and --verify are both supplied', () => {
      expect(forwardDbMigrateArgs('db:migrate', ['--reset', '--verify'])).toEqual([
        '--reset',
        '--verify',
      ]);
    });

    it('passes unknown future flags through unchanged (forward-compat)', () => {
      // The dispatcher is a router; it must not invent filtering
      // rules for flags it does not know about.
      expect(forwardDbMigrateArgs('db:migrate', ['--dry-run', '--reset'])).toEqual([
        '--dry-run',
        '--reset',
      ]);
    });
  });

  describe('db:reset (alias path)', () => {
    it('prepends --reset when the operator passes no flags', () => {
      // The whole point of the alias: `pnpm scaffold db:reset` is
      // shorthand for `pnpm scaffold db:migrate --reset`.
      expect(forwardDbMigrateArgs('db:reset', [])).toEqual(['--reset']);
    });

    it('prepends --reset and keeps --verify', () => {
      expect(forwardDbMigrateArgs('db:reset', ['--verify'])).toEqual(['--reset', '--verify']);
    });

    it('dedupes an operator-typed --reset (no double flag)', () => {
      expect(forwardDbMigrateArgs('db:reset', ['--reset'])).toEqual(['--reset']);
    });

    it('dedupes an operator-typed --reset while keeping other flags', () => {
      expect(forwardDbMigrateArgs('db:reset', ['--reset', '--verify'])).toEqual([
        '--reset',
        '--verify',
      ]);
      expect(forwardDbMigrateArgs('db:reset', ['--verify', '--reset'])).toEqual([
        '--reset',
        '--verify',
      ]);
    });
  });
});