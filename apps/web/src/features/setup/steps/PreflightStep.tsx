import { useT } from '../../../infrastructure/i18n/locale';
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
import { SetupGuidance } from '../setup-guidance';

export function PreflightStep(): ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const query = setupPreflightQuery();

  if (query.isPending) {
    return (
      <Card title={t('Preflight')}>
        <Spinner label={t('Running preflight')} />
      </Card>
    );
  }

  if (query.isError) {
    const error = query.error;
    const message = error instanceof ApiError ? error.message : 'Preflight failed';
    const code = error instanceof ApiError ? error.code : 'UNEXPECTED_ERROR';
    return (
      <Card title={t('Preflight')}>
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
      title={t('Preflight')}
      description={t('Confirm the platform bindings are reachable before continuing.')}
    >
      <SetupGuidance
        purpose="Verify that the Worker has the resources and schema required by the setup flow."
        prepare="All configured bindings and secrets must be available, and the database must be migrated to the expected schema."
        steps={[
          'Review each binding row and resolve every item marked missing.',
          'Run pending local migrations if the schema version does not match the expected version.',
          'Select Continue only after every check is present and the schema matches.',
        ]}
        success="The wizard unlocks administrator creation. This check does not modify your data."
        note="Binding presence confirms configuration; it is not a deep health check of every remote service."
      />
      <p data-testid="schema-version" className="wizard-subtitle">
        {t('Schema version: ')}
        <code>{data.schemaVersion}</code>
        {schemaOk ? null : (
          <>
            {' '}
            {t('(expected ')}
            <code>{CURRENT_SCHEMA_VERSION}</code>)
          </>
        )}
      </p>
      {!schemaOk ? (
        <Alert variant="warning" testId="schema-drift">
          {t('The deployment is on schema version ')}
          <code>{data.schemaVersion}</code>
          {t('but this client expects ')}
          <code>{CURRENT_SCHEMA_VERSION}</code>
          {t('. Run pending migrations before continuing. ')}
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
            <span className="binding-status">{present ? t('present') : t('missing')}</span>
          </li>
        ))}
      </ul>
      {!allPresent ? (
        <p className="wizard-subtitle" data-testid="bindings-incomplete">
          {t('All bindings must be present to continue.')}
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
          {t('Continue')}
        </Button>
      </div>
    </Card>
  );
}
