// apps/web — PreflightStep tests.
//
// CAP-041 AC #6: Continue is disabled when any binding is missing or
// when the response schemaVersion does not equal CURRENT_SCHEMA_VERSION.
// AC #19: per-step happy + error path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CURRENT_SCHEMA_VERSION } from '@unimailbox/contracts';
import { PreflightStep } from './PreflightStep';
import { jsonResponse, errorResponse, lastPathname, renderStep, spyFetch } from '../../../test-utils';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PreflightStep', () => {
  it('renders binding rows and the schema version (happy path AC #6)', async () => {
    const { fetchImpl } = spyFetch([
      () =>
        jsonResponse({
          data: {
            bindings: { d1: true, r2: true, kv: true },
            schemaVersion: CURRENT_SCHEMA_VERSION,
          },
        }),
    ]);
    await renderStep({ fetchImpl, step: <PreflightStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('binding-d1').getAttribute('data-present')).toBe('true');
    });
    expect(screen.getByTestId('schema-version').textContent).toContain(
      CURRENT_SCHEMA_VERSION,
    );
  });

  it('disables Continue when schemaVersion drifts (AC #6)', async () => {
    const { fetchImpl } = spyFetch([
      () =>
        jsonResponse({
          data: {
            bindings: { d1: true, r2: true, kv: true },
            schemaVersion: '0000',
          },
        }),
    ]);
    await renderStep({ fetchImpl, step: <PreflightStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('binding-d1')).toBeInTheDocument();
    });
    const button = screen.getByTestId('preflight-continue');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('schema-drift')).toBeInTheDocument();
  });

  it('disables Continue when any binding is missing', async () => {
    const { fetchImpl } = spyFetch([
      () =>
        jsonResponse({
          data: {
            bindings: { d1: true, r2: false, kv: true },
            schemaVersion: CURRENT_SCHEMA_VERSION,
          },
        }),
    ]);
    await renderStep({ fetchImpl, step: <PreflightStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('binding-r2').getAttribute('data-present')).toBe('false');
    });
    const button = screen.getByTestId('preflight-continue');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('bindings-incomplete')).toBeInTheDocument();
  });

  it('advances to /setup/administrator on Continue', async () => {
    const { fetchImpl } = spyFetch([
      () =>
        jsonResponse({
          data: {
            bindings: { d1: true, r2: true, kv: true },
            schemaVersion: CURRENT_SCHEMA_VERSION,
          },
        }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderStep({ fetchImpl, step: <PreflightStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('preflight-continue')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('preflight-continue'));
    expect(lastPathname(history)).toBe('/setup/administrator');
  });

  it('surfaces the machine code via ErrorPanel on 5xx (AC #15)', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = spyFetch([
      () => errorResponse('PREFLIGHT_FAILED', 'bindings broken', 502),
    ]);
    await renderStep({ fetchImpl, step: <PreflightStep /> });
    // 502 is retryable; drive the retry backoff (1+2+4+8+16 = 31s) so
    // the query exhausts retries and surfaces the error.
    await vi.advanceTimersByTimeAsync(35_000);
    // Poll the DOM manually so we don't depend on waitFor's interval.
    let found: HTMLElement | null = null;
    for (let i = 0; i < 50; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      found = document.querySelector('[data-testid="error-code"]');
      if (found !== null) break;
    }
    expect(found).not.toBeNull();
    expect(found?.textContent).toBe('PREFLIGHT_FAILED');
  }, 15_000);
});