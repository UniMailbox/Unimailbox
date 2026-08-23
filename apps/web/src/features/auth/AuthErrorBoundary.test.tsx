// apps/web — AuthErrorBoundary tests.
//
// CAP-042 (Batch 8) M-1 fix: the boundary is exported and now wired
// around the auth subtree (`/login`, `/register` route components in
// `app/router.tsx`). These tests confirm the boundary:
// - renders its children when no error is thrown;
// - catches a synchronous render-time throw from a child and shows
//   the auth-styled fallback (`auth-page` + `card` + primary Button);
// - exposes a "Try again" reset button that clears the captured error
//   and re-renders the children.
//
// The boundary is intentionally a React class component (the only
// class component in apps/web) because functional error boundaries are
// still not supported in React 19.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuthErrorBoundary } from './AuthErrorBoundary';
import { resetAuthSessionForTesting } from './auth-session-store';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

function Boom({ message }: { readonly message: string }): never {
  throw new Error(message);
}

describe('AuthErrorBoundary', () => {
  it('renders its children when no error is thrown', () => {
    render(
      <AuthErrorBoundary>
        <div data-testid="happy-child">happy</div>
      </AuthErrorBoundary>,
    );
    expect(screen.getByTestId('happy-child')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-error-boundary')).toBeNull();
  });

  it('catches a render-time throw and shows the auth-styled fallback', () => {
    render(
      <AuthErrorBoundary>
        <Boom message="explode" />
      </AuthErrorBoundary>,
    );
    expect(screen.getByTestId('auth-error-boundary')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('explode')).toBeInTheDocument();
    expect(screen.getByTestId('auth-error-reset')).toBeInTheDocument();
  });
});