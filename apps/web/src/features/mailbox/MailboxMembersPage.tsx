import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { useInAppShell } from '../../components/layouts/AppShell';
// apps/web — MailboxMembersPage.
//
// CAP-065. This page is the browser surface for CAP-057's existing-member
// sharing API. The server remains the authorization authority: every signed-
// in user can reach the route, but only an owner or globally permitted actor
// receives member data or can mutate it.
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import type { MailboxMemberItem } from '@unimailbox/contracts';
import { addMailboxMemberRequestSchema } from '@unimailbox/contracts';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ApiError } from '../../infrastructure/api/errors';
import { AlertDialog } from '../../components/ui/AlertDialog';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Input } from '../../components/ui/Input';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import { MailboxLoading } from './MailboxLoading';
import { Unauthorized } from '../auth/Unauthorized';
import { LogoutButton } from '../auth/LogoutButton';
import { authSessionQuery } from '../auth/auth-queries';
import {
  mailboxMembersQuery,
  useAddMailboxMemberMutation,
  useRemoveMailboxMemberMutation,
} from './mailbox-queries';
import type { AddMailboxMemberRequest } from '@unimailbox/contracts';

type MemberFormFields = AddMailboxMemberRequest;

interface ActionError {
  readonly message: string;
  readonly code: string;
}

function asActionError(error: unknown, fallback: string): ActionError {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: 'UNKNOWN' };
  }
  return { message: fallback, code: 'UNKNOWN' };
}

export interface MailboxMembersPageProps {
  readonly mailboxId: string;
}

export function MailboxMembersPage({ mailboxId }: MailboxMembersPageProps): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return <MailboxLoading />;
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  return <MailboxMembersContent mailboxId={mailboxId} />;
}

function MailboxMembersContent({ mailboxId }: MailboxMembersPageProps): ReactElement {
  const t = useT();
  const inShell = useInAppShell();
  const sessionQuery = authSessionQuery();
  const query = mailboxMembersQuery(mailboxId);
  const addMutation = useAddMailboxMemberMutation();
  const removeMutation = useRemoveMailboxMemberMutation();
  const [pendingRemoval, setPendingRemoval] = useState<MailboxMemberItem | null>(null);
  const [removeError, setRemoveError] = useState<ActionError | null>(null);
  const [addError, setAddError] = useState<ActionError | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const removalTriggerRef = useRef<HTMLButtonElement | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<MemberFormFields>({
    resolver: zodResolver(addMailboxMemberRequestSchema),
    defaultValues: { email: '', role: 'viewer' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setAddError(null);
    setSuccessNotice(null);
    try {
      // The resolver already parsed this value, but parsing at the mutation
      // boundary makes the normalization explicit and keeps this form from
      // ever sending an untrimmed/case-sensitive address (R-DATA-001).
      const request = addMailboxMemberRequestSchema.parse(values);
      await addMutation.mutateAsync({ mailboxId, ...request });
      reset({ email: '', role: 'viewer' });
      setSuccessNotice(`${request.email} was added to the mailbox.`);
    } catch (error) {
      setAddError(asActionError(error, 'Could not add the mailbox member.'));
    }
  });

  const confirmRemoval = async (): Promise<void> => {
    if (pendingRemoval === null) return;
    const removedEmail = pendingRemoval.email;
    setRemoveError(null);
    setSuccessNotice(null);
    try {
      await removeMutation.mutateAsync({ mailboxId, memberUserId: pendingRemoval.userId });
      setPendingRemoval(null);
      setSuccessNotice(`${removedEmail} was removed from the mailbox.`);
    } catch (error) {
      setRemoveError(asActionError(error, 'Could not remove the mailbox member.'));
    }
  };

  const queryError: unknown = query.error;
  const apiError =
    queryError === null
      ? null
      : queryError instanceof ApiError
        ? queryError
        : new ApiError(
            'UNKNOWN',
            queryError instanceof Error ? queryError.message : 'Could not load mailbox members.',
            0,
          );
  const hasData = query.data !== undefined;

  useEffect(() => {
    if (pendingRemoval !== null || removalTriggerRef.current === null) return;

    const trigger = removalTriggerRef.current;
    if (trigger.isConnected) {
      trigger.focus();
    } else {
      const nextMemberAction = document.querySelector<HTMLButtonElement>(
        '[data-testid="mailbox-member-list"] button',
      );
      (nextMemberAction ?? document.getElementById('mailbox-member-email'))?.focus();
    }
    removalTriggerRef.current = null;
  }, [pendingRemoval]);

  if (!hasData && query.isPending) {
    return (
      <main className="mailbox-shell">
        <ContentSkeleton />
      </main>
    );
  }

  if (!hasData && apiError !== null) {
    return (
      <main className="mailbox-shell" data-testid="mailbox-members-error">
        <header className="mailbox-header">
          <h1 className="mailbox-title">{t('Mailbox members')}</h1>
        </header>
        <Card
          title={t('Could not load members')}
          description={t('The mailbox members are unavailable.')}
        >
          <ErrorPanel
            message={apiError.message}
            code={apiError.code}
            onRetry={() => {
              void query.refetch();
            }}
            testId="mailbox-members-error-panel"
          />
        </Card>
      </main>
    );
  }

  const members = query.data ?? [];
  const submitting = isSubmitting || addMutation.isPending;

  return (
    <main className="mailbox-shell" data-testid="mailbox-members-page">
      <header className="mailbox-header">
        <div>
          <h1 className="mailbox-title">{t('Mailbox members')}</h1>
        </div>
        <div className="mailbox-header-meta">
          <span data-testid="mailbox-user-email">{sessionQuery.data?.email ?? ''}</span>
          <Link
            to="/mailbox/$mailboxId"
            params={{ mailboxId }}
            className="mailbox-folder-link"
            data-testid="mailbox-members-back-link"
          >
            {t('Back to inbox')}
          </Link>
          {!inShell ? <LogoutButton /> : null}
        </div>
      </header>

      <div
        className="mailbox-members-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="mailbox-members-success"
      >
        {successNotice ?? ''}
      </div>

      {apiError !== null ? (
        <div
          className="mailbox-members-error-banner"
          role="alert"
          data-testid="mailbox-members-error-banner"
        >
          <p>
            {t('Could not refresh members: ')}
            {apiError.message}
          </p>
          <span className="error-panel-code">{apiError.code}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="mailbox-members-banner-retry"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('Retry')}
          </Button>
        </div>
      ) : null}

      <Card
        title={t('Add a member')}
        description={t('Add an existing active user to this mailbox.')}
      >
        <form
          className="mailbox-members-form"
          data-testid="mailbox-member-form"
          onSubmit={onSubmit}
          noValidate
        >
          <Input
            id="mailbox-member-email"
            type="email"
            autoComplete="email"
            label={t('Member email')}
            help={t('The user must already have an active account.')}
            error={errors.email?.message}
            disabled={submitting}
            {...register('email')}
          />
          <div className="wizard-field">
            <label className="input-label" htmlFor="mailbox-member-role">
              {t('Member role')}
            </label>
            <select
              id="mailbox-member-role"
              className="input"
              disabled={submitting}
              aria-invalid={errors.role !== undefined ? true : undefined}
              aria-describedby={errors.role !== undefined ? 'mailbox-member-role-error' : undefined}
              {...register('role')}
            >
              <option value="viewer">{t('Viewer — read mailbox messages')}</option>
              <option value="sender">{t('Sender — read and send messages')}</option>
              <option value="admin">{t('Admin — manage mailbox members')}</option>
            </select>
            {errors.role?.message !== undefined ? (
              <span id="mailbox-member-role-error" className="input-error" role="alert">
                {errors.role.message}
              </span>
            ) : null}
          </div>
          {addError !== null ? (
            <ErrorPanel
              message={addError.message}
              code={addError.code}
              onRetry={() => {
                void onSubmit();
              }}
              retryLabel={t('Retry add')}
              testId="mailbox-member-add-error"
            />
          ) : null}
          <div className="wizard-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={submitting}
              loading={submitting}
              data-testid="mailbox-member-add-submit"
            >
              {submitting ? t('Adding…') : t('Add member')}
            </Button>
          </div>
        </form>
      </Card>

      <Card
        title={t('Current members')}
        description={t('The mailbox owner is managed separately and is not listed here.')}
      >
        {members.length === 0 ? (
          <p data-testid="mailbox-members-empty">{t('No explicit members yet.')}</p>
        ) : (
          <ul className="mailbox-member-list" data-testid="mailbox-member-list">
            {members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                disabled={removeMutation.isPending}
                onRemove={(trigger) => {
                  removalTriggerRef.current = trigger;
                  setRemoveError(null);
                  setPendingRemoval(member);
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      <AlertDialog
        open={pendingRemoval !== null}
        name="Remove mailbox member"
        title={t('Remove this mailbox member?')}
        confirmLabel={t('Remove member')}
        confirmDisabled={removeMutation.isPending}
        confirmBusy={removeMutation.isPending}
        error={
          removeError === null ? undefined : (
            <>
              <span>{removeError.message}</span>
              <span className="error-panel-code">{removeError.code}</span>
            </>
          )
        }
        onConfirm={() => {
          void confirmRemoval();
        }}
        onCancel={() => {
          if (!removeMutation.isPending) {
            setPendingRemoval(null);
            setRemoveError(null);
          }
        }}
      >
        {pendingRemoval === null
          ? null
          : `This removes ${pendingRemoval.email} from the mailbox. They will lose access immediately.`}
      </AlertDialog>
    </main>
  );
}

interface MemberRowProps {
  readonly member: MailboxMemberItem;
  readonly disabled: boolean;
  readonly onRemove: (trigger: HTMLButtonElement) => void;
}

function MemberRow({ member, disabled, onRemove }: MemberRowProps): ReactElement {
  const t = useT();
  return (
    <li
      className="mailbox-member-row"
      data-testid={`mailbox-member-${member.userId}`}
      data-member-id={member.userId}
    >
      <div className="mailbox-member-row-meta">
        <span className="mailbox-member-row-email">{member.email}</span>
        <span className="mailbox-member-role">{member.role}</span>
      </div>
      <div className="mailbox-member-row-detail">
        <span>
          {t('name: ')}
          {member.displayName ?? '—'}
        </span>
        <span>
          {t('added: ')}
          <LocalDateTime value={member.createdAt} />
        </span>
      </div>
      <div className="mailbox-member-row-actions">
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={disabled}
          onClick={(event) => onRemove(event.currentTarget)}
        >
          {t('Remove')}
        </Button>
      </div>
    </li>
  );
}
