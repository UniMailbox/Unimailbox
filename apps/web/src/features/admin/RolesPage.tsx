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
        <p>Loading…</p>
      </main>
    );
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }
  return <RolesContent />;
}

function RolesContent(): ReactElement {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const session = authSessionQuery().data;
  const query = adminRolesQuery();
  const createNameInputRef = useRef<HTMLInputElement>(null);
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
      setNotice(`Created ${role.name}.`);
      createNameInputRef.current?.focus();
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
        <p>Loading…</p>
      </main>
    );
  }
  if (queryError?.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title="Administrator access required"
          description="Your account does not have permission to read roles."
        >
          <p>Ask an administrator if you need access to this area.</p>
        </Card>
      </main>
    );
  }
  if (!hasData && queryError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <header className="admin-header">
          <h1>Roles</h1>
        </header>
        <Card title="Could not load roles" description="Role definitions are unavailable.">
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
    return <main className="admin-page" data-testid="admin-loading" />;
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
      <header className="admin-header">
        <h1>Roles</h1>
      </header>
      <Card
        title="Role definitions"
        description="System roles are protected. Custom roles control their own permission grants."
      >
        <form
          onSubmit={submitCreate}
          className="admin-form"
          noValidate
          data-testid="role-create-form"
        >
          <h3>Create custom role</h3>
          <label htmlFor="create-role-name">Role name</label>
          <input
            id="create-role-name"
            ref={createNameInputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            aria-describedby={createError === null ? undefined : 'role-create-error'}
          />
          <label htmlFor="create-role-description">Role description</label>
          <textarea
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
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating…' : 'Create role'}
          </Button>
        </form>
        {notice !== null ? (
          <p role="status" className="admin-success" data-testid="role-success">
            {notice}
          </p>
        ) : null}
        {queryError !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="roles-query-error">
            <span>Could not refresh roles: {queryError.message}</span>{' '}
            <span>{queryError.code}</span>
            <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {data.roles.length === 0 ? (
          <p data-testid="admin-roles-empty">No roles exist yet.</p>
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
                  onDeleted={() => {
                    createNameInputRef.current?.focus();
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
  return (
    <li className="admin-role-row" data-testid={`role-${role.id}-read-only`} data-role-id={role.id}>
      <div className="admin-role-row-meta">
        <strong>{role.name}</strong>
        <span>System role</span>
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
  onDeleted,
}: {
  readonly role: Role;
  readonly permissions: ReadonlyArray<RolePermission>;
  readonly rolesKey: readonly unknown[];
  readonly onDeleted: () => void;
}): ReactElement {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [permissionKeys, setPermissionKeys] = useState<PermissionKey[]>([...role.permissionKeys]);
  const [dirty, setDirty] = useState(false);
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
      <form onSubmit={submit} className="admin-form" noValidate>
        <h3>Custom role</h3>
        <label htmlFor={`edit-role-name-${role.id}`}>Edit {role.name} role name</label>
        <input
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
          Edit {role.name} role description
        </label>
        <textarea
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
          labelPrefix={`Edit ${role.name}: `}
          legend={`Permissions for ${role.name}`}
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
        <div className="admin-role-actions">
          <Button type="submit" disabled={updateMutation.isPending || deleteMutation.isPending}>
            {updateMutation.isPending ? 'Saving…' : `Save ${role.name}`}
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={updateMutation.isPending || deleteMutation.isPending}
            onClick={() => setDeleteOpen(true)}
          >
            Delete {role.name}
          </Button>
        </div>
      </form>
      <AlertDialog
        open={deleteOpen}
        name={`Delete ${role.name}`}
        title="Delete this custom role?"
        confirmLabel={deleteMutation.isPending ? 'Deleting…' : 'Delete role'}
        confirmDisabled={deleteMutation.isPending}
        error={deleteError === null ? undefined : `${deleteError.message} (${deleteError.code})`}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteOpen(false);
        }}
        onConfirm={() => deleteMutation.mutate()}
      >
        <p>This cannot be undone. A role assigned to a user cannot be deleted.</p>
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
  return (
    <fieldset className="admin-role-permissions">
      <legend>{legend ?? (labelPrefix === '' ? 'Permissions for new role' : 'Permissions')}</legend>
      {permissions.map((permission) => {
        const checked = selected.includes(permission.key);
        const inputId = `${idPrefix}-permission-${permission.key.replaceAll('.', '-')}`;
        return (
          <label key={permission.key} htmlFor={inputId}>
            <input
              id={inputId}
              type="checkbox"
              checked={checked}
              onChange={() => {
                onChange(
                  checked
                    ? selected.filter((key) => key !== permission.key)
                    : [...selected, permission.key],
                );
              }}
            />
            {labelPrefix}
            {permission.description}
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
  const descriptions = role.permissionKeys.map(
    (key) => permissions.find((permission) => permission.key === key)?.description ?? key,
  );
  return (
    <p data-testid={`role-${role.id}-permissions`}>
      Permissions: {descriptions.length === 0 ? 'None' : descriptions.join(', ')}
    </p>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('UNKNOWN', error instanceof Error ? error.message : 'Unexpected error.', 0);
}
