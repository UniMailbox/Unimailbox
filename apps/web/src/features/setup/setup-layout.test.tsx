// apps/web — SetupLayout tests.
//
// The initial Claim page has no session to restart. The clear-session action
// only appears after Claim succeeds, when it can perform a meaningful action.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { SetupLayout } from './setup-layout';
import { jsonResponse, renderStep, spyFetch } from '../../test-utils';
import { setSetupSession } from './setup-session-store';

afterEach(() => {
  cleanup();
});

describe('SetupLayout session action', () => {
  it('does not show a restart action before the installation is claimed', async () => {
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { status: 'setup', currentStep: 'claim' } }),
    ]);

    await renderStep({ fetchImpl, step: <SetupLayout /> });

    await waitFor(() => {
      expect(screen.getByTestId('setup-layout')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('restart-wizard')).not.toBeInTheDocument();
  });

  it('shows clear setup session after Claim has created a session', async () => {
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { status: 'setup', currentStep: 'preflight' } }),
    ]);

    await renderStep({
      fetchImpl,
      step: <SetupLayout />,
    });
    setSetupSession('setup-session');

    await waitFor(() => {
      expect(screen.getByTestId('restart-wizard')).toHaveTextContent('Clear setup session');
    });
  });
});
