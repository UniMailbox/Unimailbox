import type { ReactElement } from 'react';
import type { PersonalMcpSettings } from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { useT } from '../../infrastructure/i18n/locale';
export function McpCredentialList({
  tokens,
  mailboxes,
  busy,
  onRevoke,
}: {
  tokens: PersonalMcpSettings['tokens'];
  mailboxes: PersonalMcpSettings['mailboxes'];
  busy: boolean;
  onRevoke: (id: string) => void;
}): ReactElement {
  const t = useT();
  return (
    <section className="space-y-3" aria-label={t('Existing credentials')}>
      <h3 className="font-medium">{t('Existing credentials')}</h3>
      <p className="text-xs text-muted-foreground">
        {t('To change permissions, revoke the credential and create a replacement.')}
      </p>
      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('No agent credentials yet.')}</p>
      ) : (
        tokens.map((token) => {
          const active = token.revokedAt === null && token.expiresAt > Date.now() / 1000;
          return (
            <div key={token.id} className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <strong className="break-all">{token.label}</strong>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(token.revokedAt !== null ? 'Revoked' : active ? 'Active' : 'Expired')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  t('Read mail'),
                  ...(token.allowDraft ? [t('Drafts / AI replies')] : []),
                  ...(token.allowSend ? [t('Send mail')] : []),
                ].join(' · ')}
              </p>
              <p className="break-all text-xs">
                {token.mailboxIds
                  .map(
                    (id) =>
                      mailboxes.find((box) => box.id === id)?.address ??
                      t('Mailbox access removed'),
                  )
                  .join(', ')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('Expires')}: {new Date(token.expiresAt * 1000).toLocaleString()}
              </p>
              {active ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`${t('Revoke credential')}: ${token.label}`}
                  onClick={() => onRevoke(token.id)}
                >
                  {t('Revoke credential')}
                </Button>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
