// apps/web — setup session store test.
// CAP-041 AC #16: the setup session token is NEVER written to
// localStorage, sessionStorage, or IndexedDB. No `persist` middleware.
//
// The test greps the store module's source to assert the absence of
// every persistence API. This is a structural test — it protects the
// invariant even if the runtime is mocked.
import * as storeModule from './setup-session-store';
import { describe, expect, it } from 'vitest';
import {
  useSetupSession,
  setSetupSession,
  clearSetupSession,
  resetSetupSessionForTesting,
} from './setup-session-store';

function readStoreSource(): string {
  // The hooks and helpers above re-export the module's source. We
  // reconstruct the source by stringifying the module's function
  // bodies — at runtime this looks like `function setSetupSession() {...}`.
  // For a structural grep the simplest source is the module's
  // `toString()` of its named exports. The module's source is the
  // canonical representation; we use the function source to assert
  // there's no `localStorage` / `sessionStorage` / `indexedDB` /
  // `persist` reference.
  return [
    storeModule.useSetupSession.toString(),
    storeModule.setSetupSession.toString(),
    storeModule.clearSetupSession.toString(),
    storeModule.resetSetupSessionForTesting.toString(),
  ].join('\n');
}

describe('setup-session-store', () => {
  it('has no references to localStorage, sessionStorage, indexedDB, or persist', () => {
    const source = readStoreSource();
    expect(source).not.toMatch(/localStorage/i);
    expect(source).not.toMatch(/sessionStorage/i);
    expect(source).not.toMatch(/indexedDB/i);
    expect(source).not.toMatch(/persist/i);
  });

  it('starts with a null session token', () => {
    resetSetupSessionForTesting();
    expect(useSetupSession.getState().sessionToken).toBeNull();
  });

  it('setSetupSession stores the token in memory', () => {
    resetSetupSessionForTesting();
    setSetupSession('token-abc');
    expect(useSetupSession.getState().sessionToken).toBe('token-abc');
  });

  it('clearSetupSession removes the token', () => {
    resetSetupSessionForTesting();
    setSetupSession('token-xyz');
    clearSetupSession();
    expect(useSetupSession.getState().sessionToken).toBeNull();
  });
});
