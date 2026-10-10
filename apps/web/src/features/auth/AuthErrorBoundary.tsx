import { translate } from '../../infrastructure/i18n/locale';
import { errorMessage } from '../../infrastructure/i18n/error-messages';
// apps/web — AuthErrorBoundary.
//
// CAP-042 (Batch 5) AC 20. Error boundary for the auth surface. Catches
// render-time errors inside `<LoginPage>`, `<RegisterPage>`,
// `<Unauthorized>`, etc., and shows a typed message + retry link. The
// top-level `ErrorBoundary` in `App.tsx` is the outermost fallback; this
// one keeps the auth surface self-contained so a query failure inside a
// form does not take the whole router down.
//
// Per `.claude/rules/coding.md` §Errors: never swallow an error to keep
// a happy path green. The boundary logs to the console (developer
// correlation) and surfaces the message to the user.
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';

interface AuthErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AuthErrorBoundaryState {
  readonly error: Error | null;
}

export class AuthErrorBoundary extends Component<AuthErrorBoundaryProps, AuthErrorBoundaryState> {
  override state: AuthErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AuthErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No remote sink in CAP-001; log to the browser console for
    // developer correlation. Never log request bodies, tokens, or
    // passwords — R-LOG-001 / R-SECRET-003.
    console.error('Auth surface error', error, info);
  }

  override render(): ReactElement {
    if (this.state.error !== null) {
      const message = errorMessage('INTERNAL');
      return (
        <main className="auth-page" data-testid="auth-error-boundary">
          <section className="card">
            <h2 className="card-title">{translate('Something went wrong')}</h2>
            <p className="card-description">{message}</p>
            <span className="error-panel-code">INTERNAL</span>
            <div className="wizard-actions">
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  this.setState({ error: null });
                }}
                data-testid="auth-error-reset"
              >
                {translate('Try again')}
              </Button>
            </div>
          </section>
        </main>
      );
    }
    // `this.props.children` is typed as `ReactNode` (which includes
    // `undefined`); wrap in a Fragment so the render method's
    // `ReactElement` return type matches at runtime.
    return <>{this.props.children}</>;
  }
}
