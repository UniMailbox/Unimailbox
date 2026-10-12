import type { ReactElement } from 'react';
import { UPSTREAM_URL, UPGRADE_GUIDE_URL } from '@unimailbox/contracts';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import { ApiError } from '../../infrastructure/api/errors';
import { useT } from '../../infrastructure/i18n/locale';
import { authSessionQuery } from '../auth/auth-queries';
import { useUpdateCheck } from './update-queries';

const messages = {
  available: 'A new version is available: {version}.',
  current: 'You are running the latest stable version.',
  ahead: 'This installation is ahead of the latest stable release.',
  no_release: 'No stable release has been published yet.',
  unavailable: 'Could not check for updates. Try again later or view GitHub releases.',
  disabled: 'Update checks are disabled for this installation.',
} as const;

export function UpdatePanel(): ReactElement | null {
  const t = useT();
  const session = authSessionQuery().data;
  const query = useUpdateCheck();
  if (!session) return null;
  if (query.error instanceof ApiError && [401, 403].includes(query.error.status)) return null;
  const data = query.data;
  const status = query.isError ? 'unavailable' : data?.status;
  return (
    <Card
      title={t('Software updates')}
      testId="admin-updates"
      actions={
        <>
          <Button
            variant="secondary"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t('Check for updates')}
          </Button>
          <a
            href={
              data?.latest
                ? `${UPSTREAM_URL}/releases/tag/${data.latest.tag}`
                : `${UPSTREAM_URL}/releases`
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('Release notes')}
          </a>
          <a href={UPGRADE_GUIDE_URL} target="_blank" rel="noopener noreferrer">
            {t('Upgrade guide')}
          </a>
        </>
      }
    >
      <div className="space-y-2" role="status">
        <p>
          {status
            ? t(messages[status], { version: data?.latest?.tag ?? '' })
            : t('Checking for updates…')}
        </p>
        {data ? (
          <p className="text-sm text-muted-foreground">
            {t('Installed base version: {version}', { version: data.current.version })}
            {' · '}
            {t('Revision: {revision}', { revision: data.current.revision.slice(0, 12) })}
          </p>
        ) : null}
        {data?.checkedAt ? (
          <p className="text-sm text-muted-foreground">
            {t('Last checked')}: <LocalDateTime value={data.checkedAt} />
          </p>
        ) : null}
        {status === 'available' ? (
          <p className="text-sm text-muted-foreground">
            {t(
              'Review release notes and back up your data before upgrading. Fork changes require review.',
            )}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
