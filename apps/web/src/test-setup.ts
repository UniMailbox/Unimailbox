// apps/web — test setup.
// Adds @testing-library/jest-dom matchers to every suite. The unhandled
// fetch rejection filter is a polite default for tests that intentionally
// mock fetch to assert error envelopes; otherwise a thrown `ApiError` would
// bubble as an unhandled rejection and Vitest would fail the run.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// happy-dom has no physical pointer capture or layout scrolling. Radix Select
// uses these browser APIs; real interaction/layout is also checked in staging.
for (const name of [
  'hasPointerCapture',
  'setPointerCapture',
  'releasePointerCapture',
  'scrollIntoView',
] as const) {
  if (!(name in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: name === 'hasPointerCapture' ? () => false : () => undefined,
    });
  }
}
