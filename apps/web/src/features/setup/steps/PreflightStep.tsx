// apps/web — PreflightStep.
//
// CAP-041 / step 2. Calls POST /api/v1/setup/preflight and renders each
// binding as a row (green/red). The "Continue" button is enabled only
// when (a) all bindings are present AND (b) the response's
// schemaVersion equals `CURRENT_SCHEMA_VERSION` exported by
// `@unimailbox/contracts`. AC #6: schema drift between the deployed
// migrations and the running client must surface here, not silently
// allow the operator to walk into a half-applied deployment.
//
// R-DATA-001: the response is the source of truth; the wizard does not
// re-validate the response.
import { useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { CURRENT_SCHEMA_VERSION } from '@unimailbox/contracts';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { Alert } from '../../../components/ui/Alert';
import { ApiError } from '../../../infrastructure/api/errors';
import { setupPreflightQuery } from '../setup-queries';

export function PreflightStep(): ReactElement {
  const navigate = useNavigate();
  const query = setupPreflightQuery();

  if (query.isPending) {
    return (
      <Card title="Preflight">
        <Spinner label="Running preflight" />
      </Card>
    );
  }

  if (query.isError) {
    const error = query.error;
    const message = error instanceof ApiError ? error.message : 'Preflight failed';
    const code = error instanceof ApiError ? error.code : 'UNEXPECTED_ERROR';
    return (
      <Card title="Preflight">
        <ErrorPanel
          message={message}
          code={code}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }

  const data = query.data;
  const bindings = Object.entries(data.bindings);
  const allPresent = bindings.every(([, present]) => present);
  // AC #6 (CAP-041 fix): gate the Continue button on schema version.
  // The contracts package is the single source of truth — if the worker
  // is on an older migration, the operator sees a drift notice.
  const schemaOk = data.schemaVersion === CURRENT_SCHEMA_VERSION;

  return (
    <Card
      title="Preflight"
      description="Confirm the platform bindings are reachable before continuing."
    >
      <p data-testid="schema-version" className="wizard-subtitle">
        Schema version: <code>{data.schemaVersion}</code>
        {schemaOk ? null : (
          <>
            {' '}
            (expected <code>{CURRENT_SCHEMA_VERSION}</code>)
          </>
        )}
      </p>
      {!schemaOk ? (
        <Alert variant="warning" testId="schema-drift">
          The deployment is on schema version <code>{data.schemaVersion}</code>
          but this client expects <code>{CURRENT_SCHEMA_VERSION}</code>. Run pending migrations
          before continuing.
        </Alert>
      ) : null}
      <ul className="binding-list" data-testid="binding-list">
        {bindings.map(([name, present]) => (
          <li
            key={name}
            className="binding-row"
            data-present={present ? 'true' : 'false'}
            data-testid={`binding-${name}`}
          >
            <span className="binding-name">{name}</span>
            <span className="binding-status">{present ? 'present' : 'missing'}</span>
          </li>
        ))}
      </ul>
      {!allPresent ? (
        <p className="wizard-subtitle" data-testid="bindings-incomplete">
          All bindings must be present to continue.
        </p>
      ) : null}
      <div className="wizard-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!allPresent || !schemaOk}
          onClick={() => {
            void navigate({ to: '/setup/administrator' });
          }}
          data-testid="preflight-continue"
        >
          Continue
        </Button>
      </div>
    </Card>
  );
}
