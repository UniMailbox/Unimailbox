import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { Badge } from '../../components/ui/shadcn/badge';
import { Checkbox } from '../../components/ui/shadcn/checkbox';
import { Input as PrimitiveInput } from '../../components/ui/shadcn/input';
import { Textarea } from '../../components/ui/shadcn/textarea';
import { PageHeader } from '../../components/ui/PageHeader';
// apps/web — role administration (CAP-067).
//
// The page is session-gated by the router. The Worker remains the authority
// for role.read/role.manage; client state only renders server responses and
// never grants a permission.

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createRoleRequestSchema,
  type PermissionKey,
  type Role,
  type RoleListResponse,
  type RolePermission,
} from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { AlertDialog } from '../../components/ui/AlertDialog';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import {
  adminQueryKeys,
  adminRolesQuery,
  createAdminRole,
  deleteAdminRole,
  updateAdminRole,
} from './admin-queries';

export function RolesPage(): ReactElement {
  const sessionQuery = authSessionQuery();
  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
      </main>
    );
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }
  return <RolesContent />;
}

function RolesContent(): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const session = authSessionQuery().data;
  const query = adminRolesQuery();
  const createNameInputRef = useRef<HTMLInputElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissionKeys, setPermissionKeys] = useState<PermissionKey[]>([]);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const userId = session?.userId ?? 'anonymous';
  const rolesKey = adminQueryKeys.roles(userId);
  const createMutation = useMutation({
    mutationFn: (request: {
      readonly name: string;
      readonly description: string;
      readonly permissionKeys: ReadonlyArray<PermissionKey>;
    }) => createAdminRole(apiClient, request),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: rolesKey });
      setCreateError(null);
      setNotice(null);
    },
    onSuccess: (role) => {
      queryClient.setQueryData<RoleListResponse>(rolesKey, (current) =>
        current === undefined ? current : { ...current, roles: [...current.roles, role] },
      );
      setName('');
      setDescription('');
      setPermissionKeys([]);
      setNotice(t('Created {value0}.', { value0: role.name }));
      setCreateOpen(false);
      void queryClient.invalidateQueries({ queryKey: rolesKey, refetchType: 'none' });
    },
    onError: (error) => {
      setCreateError(normalizeApiError(error));
    },
  });

  const queryError = query.error === null ? null : normalizeApiError(query.error);
  const hasData = query.data !== undefined;
  if (!hasData && query.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
      </main>
    );
  }
  if (queryError?.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title={t('Administrator access required')}
          description={t('Your account does not have permission to read roles.')}
        >
          <p>{t('Ask an administrator if you need access to this area.')}</p>
        </Card>
      </main>
    );
  }
  if (!hasData && queryError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <PageHeader
          title={t('Roles')}
          actions={
            <Button
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
            >
              {t('New role')}
            </Button>
          }
        />
        <Card
          title={t('Could not load roles')}
          description={t('Role definitions are unavailable.')}
        >
          <ErrorPanel
            message={queryError.message}
            code={queryError.code}
            onRetry={() => void query.refetch()}
            testId="admin-error-panel"
          />
        </Card>
      </main>
    );
  }

  const data = query.data;
  if (data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
      </main>
    );
  }

  const submitCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = createRoleRequestSchema.safeParse({ name, description, permissionKeys });
    if (!parsed.success) {
      setCreateError(new ApiError('VALIDATION_ERROR', 'Enter a role name and description.', 400));
      return;
    }
    createMutation.mutate(parsed.data);
  };

  return (
    <main className="admin-page" data-testid="admin-roles-page">
      <PageHeader
        title={t('Roles')}
        actions={
          <Button
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            {t('New role')}
          </Button>
        }
      />
      <Card
        title={t('Role definitions')}
        description={t(
          'System roles are protected. Custom roles control their own permission grants.',
        )}
      >
        <EditorDialog
          open={createOpen}
          onOpenChange={(open) => {
            if (createMutation.isPending) return;
            setCreateOpen(open);
            if (!open) {
              setName('');
              setDescription('');
              setPermissionKeys([]);
              setCreateError(null);
            }
          }}
          title={t('New role')}
          description={t('Choose a name and permissions for a custom role.')}
        >
          <form
            onSubmit={submitCreate}
            className="admin-form"
            noValidate
            data-testid="role-create-form"
          >
            <label htmlFor="create-role-name">{t('Role name')}</label>
            <PrimitiveInput
              id="create-role-name"
              ref={createNameInputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              aria-describedby={createError === null ? undefined : 'role-create-error'}
            />
            <label htmlFor="create-role-description">{t('Role description')}</label>
            <Textarea
              id="create-role-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <PermissionCheckboxes
              permissions={data.permissions}
              selected={permissionKeys}
              onChange={setPermissionKeys}
              labelPrefix=""
            />
            {createError !== null ? (
              <div className="admin-error-banner" role="alert" data-testid="role-create-error">
                <span>{createError.message}</span> <span>{createError.code}</span>
              </div>
            ) : null}
            <div className="admin-dialog-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={createMutation.isPending}
                onClick={() => {
                  setCreateOpen(false);
                  setName('');
                  setDescription('');
                  setPermissionKeys([]);
                  setCreateError(null);
                }}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                loading={createMutation.isPending}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? t('Creating…') : t('Create role')}
              </Button>
            </div>
          </form>
        </EditorDialog>
        {notice !== null ? (
          <p role="status" className="admin-success" data-testid="role-success">
            {notice}
          </p>
        ) : null}
        {queryError !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="roles-query-error">
            <span>
              {t('Could not refresh roles: ')}
              {queryError.message}
            </span>{' '}
            <span>{queryError.code}</span>
            <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
              {t('Retry')}
            </Button>
          </div>
        ) : null}
        {data.roles.length === 0 ? (
          <p data-testid="admin-roles-empty">{t('No roles exist yet.')}</p>
        ) : (
          <ul className="admin-role-list" data-testid="admin-roles-list">
            {data.roles.map((role) =>
              role.isSystem ? (
                <SystemRoleRow key={role.id} role={role} permissions={data.permissions} />
              ) : (
                <EditableRoleRow
                  key={role.id}
                  role={role}
                  permissions={data.permissions}
                  rolesKey={rolesKey}
                  onUpdated={(name) => setNotice(t('Saved {value0}.', { value0: name }))}
                  onDeleted={() => {
                    setNotice(t('Deleted {value0}.', { value0: role.name }));
                    document
                      .querySelector<HTMLButtonElement>(
                        '[data-testid=admin-roles-page] .page-header button',
                      )
                      ?.focus();
                  }}
                />
              ),
            )}
          </ul>
        )}
      </Card>
    </main>
  );
}

function SystemRoleRow({
  role,
  permissions,
}: {
  readonly role: Role;
  readonly permissions: ReadonlyArray<RolePermission>;
}): ReactElement {
  const t = useT();
  return (
    <li className="admin-role-row" data-testid={`role-${role.id}-read-only`} data-role-id={role.id}>
      <div className="admin-role-row-meta">
        <strong>{role.name}</strong>
        <Badge variant="secondary">{t('System role')}</Badge>
      </div>
      <p>{role.description}</p>
      <PermissionSummary role={role} permissions={permissions} />
    </li>
  );
}

function EditableRoleRow({
  role,
  permissions,
  rolesKey,
  onUpdated,
  onDeleted,
}: {
  readonly role: Role;
  readonly permissions: ReadonlyArray<RolePermission>;
  readonly rolesKey: readonly unknown[];
  readonly onUpdated: (name: string) => void;
  readonly onDeleted: () => void;
}): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [permissionKeys, setPermissionKeys] = useState<PermissionKey[]>([...role.permissionKeys]);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [validationError, setValidationError] = useState<ApiError | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setName(role.name);
    setDescription(role.description);
    setPermissionKeys([...role.permissionKeys]);
  }, [dirty, role.description, role.name, role.permissionKeys]);

  const updateMutation = useMutation({
    mutationFn: (request: {
      readonly name: string;
      readonly description: string;
      readonly permissionKeys: ReadonlyArray<PermissionKey>;
    }) => updateAdminRole(apiClient, role.id, request),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: rolesKey });
      setValidationError(null);
    },
    onSuccess: (updated) => {
      setDirty(false);
      setEditing(false);
      onUpdated(updated.name);
      queryClient.setQueryData<RoleListResponse>(rolesKey, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              roles: current.roles.map((item) => (item.id === updated.id ? updated : item)),
            },
      );
      void queryClient.invalidateQueries({ queryKey: rolesKey, refetchType: 'none' });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAdminRole(apiClient, role.id),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: rolesKey });
    },
    onSuccess: (result) => {
      queryClient.setQueryData<RoleListResponse>(rolesKey, (current) =>
        current === undefined
          ? current
          : { ...current, roles: current.roles.filter((item) => item.id !== result.id) },
      );
      setDeleteOpen(false);
      onDeleted();
      void queryClient.invalidateQueries({ queryKey: rolesKey, refetchType: 'none' });
    },
  });
  const updateError =
    updateMutation.error === null ? null : normalizeApiError(updateMutation.error);
  const deleteError =
    deleteMutation.error === null ? null : normalizeApiError(deleteMutation.error);
  const roleUpdateError = validationError ?? updateError;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = createRoleRequestSchema.safeParse({ name, description, permissionKeys });
    if (parsed.success) {
      updateMutation.mutate(parsed.data);
    } else {
      setValidationError(
        new ApiError('VALIDATION_ERROR', 'Enter a role name and description.', 400),
      );
    }
  };

  return (
    <li className="admin-role-row" data-testid={`role-form-${role.id}`} data-role-id={role.id}>
      <div className="resource-row-header">
        <div>
          <strong>{role.name}</strong>
          <Badge variant="outline">{t('Custom role')}</Badge>
        </div>
        <div className="resource-row-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing(true)}
            aria-label={t('Edit {value0}', { value0: role.name })}
          >
            {t('Edit')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={t('Delete {value0}', { value0: role.name })}
            disabled={updateMutation.isPending || deleteMutation.isPending}
            onClick={() => setDeleteOpen(true)}
          >
            {t('Delete')}
          </Button>
        </div>
      </div>
      <p className="resource-row-description">{role.description}</p>
      <PermissionSummary role={role} permissions={permissions} />
      <EditorDialog
        open={editing}
        onOpenChange={(open) => {
          if (updateMutation.isPending) return;
          if (!open) {
            setDirty(false);
            setName(role.name);
            setDescription(role.description);
            setPermissionKeys([...role.permissionKeys]);
            setValidationError(null);
            updateMutation.reset();
          }
          setEditing(open);
        }}
        title={t('Edit {value0}', { value0: role.name })}
        description={t('Update the role name and permission grants.')}
      >
        <form onSubmit={submit} className="admin-form" noValidate>
          <label htmlFor={`edit-role-name-${role.id}`}>
            {t('Edit ')}
            {role.name} {t('role name')}
          </label>
          <PrimitiveInput
            id={`edit-role-name-${role.id}`}
            value={name}
            onChange={(event) => {
              setDirty(true);
              setName(event.target.value);
            }}
            autoComplete="off"
            required
            aria-invalid={roleUpdateError === null ? undefined : true}
            aria-describedby={roleUpdateError === null ? undefined : `role-update-error-${role.id}`}
          />
          <label htmlFor={`edit-role-description-${role.id}`}>
            {t('Edit ')}
            {role.name} {t('role description ')}
          </label>
          <Textarea
            id={`edit-role-description-${role.id}`}
            value={description}
            onChange={(event) => {
              setDirty(true);
              setDescription(event.target.value);
            }}
            required
            aria-invalid={roleUpdateError === null ? undefined : true}
            aria-describedby={roleUpdateError === null ? undefined : `role-update-error-${role.id}`}
          />
          <PermissionCheckboxes
            permissions={permissions}
            selected={permissionKeys}
            onChange={(keys) => {
              setDirty(true);
              setPermissionKeys(keys);
            }}
            labelPrefix={t('Edit {value0}: ', { value0: role.name })}
            legend={t('Permissions for {value0}', { value0: role.name })}
            idPrefix={`edit-${role.id}`}
          />
          {roleUpdateError !== null ? (
            <div
              className="admin-error-banner"
              role="alert"
              id={`role-update-error-${role.id}`}
              data-testid={`role-update-error-${role.id}`}
            >
              <span>{roleUpdateError.message}</span> <span>{roleUpdateError.code}</span>
            </div>
          ) : null}
          {deleteError !== null ? (
            <div
              className="admin-error-banner"
              role="alert"
              data-testid={`role-delete-error-${role.id}`}
            >
              <span>{deleteError.message}</span> <span>{deleteError.code}</span>
            </div>
          ) : null}
          <div className="admin-dialog-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={updateMutation.isPending || deleteMutation.isPending}
              onClick={() => {
                setEditing(false);
                setDirty(false);
                setName(role.name);
                setDescription(role.description);
                setPermissionKeys([...role.permissionKeys]);
                setValidationError(null);
                updateMutation.reset();
              }}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="submit"
              loading={updateMutation.isPending}
              disabled={updateMutation.isPending || deleteMutation.isPending}
            >
              {updateMutation.isPending ? t('Saving…') : t('Save {value0}', { value0: role.name })}
            </Button>
          </div>
        </form>
      </EditorDialog>
      <AlertDialog
        open={deleteOpen}
        name={t('Delete {value0}', { value0: role.name })}
        title={t('Delete this custom role?')}
        confirmLabel={deleteMutation.isPending ? t('Deleting…') : t('Delete role')}
        confirmDisabled={deleteMutation.isPending}
        confirmBusy={deleteMutation.isPending}
        error={deleteError === null ? undefined : `${deleteError.message} (${deleteError.code})`}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteOpen(false);
        }}
        onConfirm={() => deleteMutation.mutate()}
      >
        <p>{t('This cannot be undone. A role assigned to a user cannot be deleted.')}</p>
      </AlertDialog>
    </li>
  );
}

function PermissionCheckboxes({
  permissions,
  selected,
  onChange,
  labelPrefix,
  legend,
  idPrefix = 'create',
}: {
  readonly permissions: ReadonlyArray<RolePermission>;
  readonly selected: ReadonlyArray<PermissionKey>;
  readonly onChange: (keys: PermissionKey[]) => void;
  readonly labelPrefix: string;
  readonly legend?: string;
  readonly idPrefix?: string;
}): ReactElement {
  const t = useT();
  return (
    <fieldset className="admin-role-permissions">
      <legend>
        {legend ?? t(labelPrefix === '' ? 'Permissions for new role' : 'Permissions')}
      </legend>
      {permissions.map((permission) => {
        const checked = selected.includes(permission.key);
        const inputId = `${idPrefix}-permission-${permission.key.replaceAll('.', '-')}`;
        return (
          <label key={permission.key} htmlFor={inputId}>
            <Checkbox
              id={inputId}
              checked={checked}
              onCheckedChange={() => {
                onChange(
                  checked
                    ? selected.filter((key) => key !== permission.key)
                    : [...selected, permission.key],
                );
              }}
            />
            {labelPrefix}
            {t(permission.description)}
          </label>
        );
      })}
    </fieldset>
  );
}

function PermissionSummary({
  role,
  permissions,
}: {
  readonly role: Role;
  readonly permissions: ReadonlyArray<RolePermission>;
}): ReactElement {
  const t = useT();
  const descriptions = role.permissionKeys.map((key) =>
    t(permissions.find((permission) => permission.key === key)?.description ?? key),
  );
  return (
    <details className="permission-summary">
      <summary>
        {descriptions.length} {t('permissions')}
      </summary>
      <p data-testid={`role-${role.id}-permissions`}>
        {t('Permissions: ')}
        {descriptions.length === 0 ? t('None') : descriptions.join(', ')}
      </p>
    </details>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('UNKNOWN', error instanceof Error ? error.message : 'Unexpected error.', 0);
}
