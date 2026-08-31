// apps/web — admin TanStack Query hooks.
//
// CAP-044 Slice 2 (AC 13/14; CAP-033 absorbed, D-CAP-044-E). The audit
// events read surface for the /admin section:
//   - `auditEventsPath` — the pure URL builder for
//     `GET /api/v1/admin/audit-events`, exported for unit tests (AC 14).
//   - `fetchAuditEventsPage` — one page fetch, parsed through the
//     contracts `auditEventListResponseSchema`.
//   - `auditEventsInfiniteQuery` — the page's `useInfiniteQuery`, mirroring
//     `mailboxMessagesInfiniteQuery` (cursor is opaque; never inspected).
//
// CAP-044 Slice 3 (AC 19–21 + D-CAP-044-K) adds:
//   - the users list read (`usersPath`, `fetchUsersPage`,
//     `usersInfiniteQuery`) over the contracts `userListResponseSchema`;
//   - the connections + webhook-events reads over the LIVE CAP-025
//     endpoints, modeled by LOCAL zod schemas (see the note at
//     `adminConnectionSchema` — no contracts schema exists for these
//     surfaces yet; promoting them is reported to the orchestrator, not
//     decided here);
//   - `revealWebhookSecret` — the POST for the audited one-time reveal
//     (R-SECRET-003). The returned secret is displayed ONCE by
//     ConnectionsPage and never logged or persisted; this module only
//     transports it.
//   - `useAdminNavProbe` — the AppNav authorization probe (D-CAP-044-K):
//     one `GET /api/v1/admin/audit-events?limit=1`; 200 → the AppNav
//     "Admin" link renders, 403/error → nothing.
//
// D-CAP-044-D authorization note: the auth session descriptor carries NO
// role/permission signal (see features/auth/auth-queries.ts — Better Auth
// get-session returns user + session only), so the client cannot pre-hide
// the admin surface. Authorization is enforced SERVER-side
// (requirePermission('audit.read')); a member who navigates here receives
// 403 PERMISSION_DENIED, which the page renders as a not-authorized state
// (AC 14) rather than a crash. The nav-signal gap is reported to the
// orchestrator — widening the session endpoint is not this slice's call.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  auditEventListResponseSchema,
  deleteManagedDomainResponseSchema,
  managedDomainListResponseSchema,
  managedDomainSchema,
  verifyManagedDomainResponseSchema,
  userListResponseSchema,
  type ManagedDomain,
  type AuditAction,
  type AuditEventListResponse,
  roleListResponseSchema,
  roleMutationResponseSchema,
  deleteRoleResponseSchema,
  type PermissionKey,
  type Role,
  type RoleListResponse,
  type UserListResponse,
} from '@unimailbox/contracts';
import { z } from 'zod';
import type { ApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { authSessionQuery } from '../auth/auth-queries';

/** The composable filter set (the query params minus cursor/limit). */
export interface AuditEventFilterInput {
  readonly actorUserId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly action?: AuditAction;
}

/**
 * Builds the request path for one audit-events page. Deterministic param
 * order (actorUserId, resourceType, resourceId, action, cursor) so the
 * derived query key (below) is stable for identical filter sets. Values
 * are URL-encoded; empty-string filter values are dropped — the server's
 * zod schema rejects `actorUserId=''` (uuid) and the pair rule makes a
 * half-empty resource pair a 400, so the client never sends them.
 * (`action` needs no empty check: its type is the closed AuditAction
 * union — the empty sentinel never reaches the builder.)
 */
export function auditEventsPath(filters: AuditEventFilterInput, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.actorUserId !== undefined && filters.actorUserId !== '') {
    params.set('actorUserId', filters.actorUserId);
  }
  if (filters.resourceType !== undefined && filters.resourceType !== '') {
    params.set('resourceType', filters.resourceType);
  }
  if (filters.resourceId !== undefined && filters.resourceId !== '') {
    params.set('resourceId', filters.resourceId);
  }
  if (filters.action !== undefined) {
    params.set('action', filters.action);
  }
  if (cursor !== undefined && cursor !== '') {
    params.set('cursor', cursor);
  }
  const qs = params.toString();
  return qs === '' ? '/api/v1/admin/audit-events' : `/api/v1/admin/audit-events?${qs}`;
}

export const adminQueryKeys = {
  all: ['admin'] as const,
  // The audit key serializes the filters through the SAME path builder
  // the fetcher uses, so two filter sets that produce one URL produce
  // one cache entry — no parallel keys for identical requests.
  //
  // EVERY admin data key carries the session userId (fix (a), ruling 1):
  // sign-out nulls only the session entry — it does not clear admin
  // keys — so without the userId a second user on the same browser
  // would render the first user's cached rows under their own (403)
  // session: a cross-user disclosure held on screen by the data-first
  // render contract. A different user is a different key; their mount
  // starts from an empty cache. The nav probe (below) set this
  // precedent; fix (a) applies it to every data surface.
  auditEvents: (userId: string, filters: AuditEventFilterInput) =>
    [...adminQueryKeys.all, 'audit-events', userId, auditEventsPath(filters)] as const,
  users: (userId: string) => [...adminQueryKeys.all, 'users', userId] as const,
  connections: (userId: string) => [...adminQueryKeys.all, 'connections', userId] as const,
  webhookEvents: (userId: string) => [...adminQueryKeys.all, 'webhook-events', userId] as const,
  domains: (userId: string) => [...adminQueryKeys.all, 'domains', userId] as const,
  roles: (userId: string) => [...adminQueryKeys.all, 'roles', userId] as const,
  navProbe: (userId: string) => [...adminQueryKeys.all, 'nav-probe', userId] as const,
};

/** Builds the resource path for one managed-domain mutation. */
export function managedDomainPath(domainId: string): string {
  return `/api/v1/admin/domains/${encodeURIComponent(domainId)}`;
}

/** Builds the resource path for one role mutation. */
export function rolePath(roleId: string): string {
  return `/api/v1/admin/roles/${encodeURIComponent(roleId)}`;
}

/** Fetches the role definitions and the closed permission catalog. */
export async function fetchAdminRoles(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<RoleListResponse> {
  const response = await apiClient.fetch<{ readonly data: unknown }>(
    '/api/v1/admin/roles',
    signal === undefined ? {} : { signal },
  );
  try {
    return roleListResponseSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

export function adminRolesQuery() {
  const apiClient = useApiClient();
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: adminQueryKeys.roles(session?.userId ?? 'anonymous'),
    queryFn: ({ signal }) => fetchAdminRoles(apiClient, signal),
    staleTime: 0,
    enabled: session !== undefined && session !== null,
  });
}

/** Creates a custom role and validates the safe returned projection. */
type RoleMutationRequest = {
  readonly name: string;
  readonly description: string;
  readonly permissionKeys: ReadonlyArray<PermissionKey>;
};

export async function createAdminRole(
  apiClient: ApiClient,
  request: RoleMutationRequest,
): Promise<Role> {
  const response = await apiClient.fetch<{ readonly data: unknown }>('/api/v1/admin/roles', {
    method: 'POST',
    body: request,
  });
  try {
    return roleMutationResponseSchema.parse(response).data;
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/** Replaces a custom role definition and permission set. */
export async function updateAdminRole(
  apiClient: ApiClient,
  roleId: string,
  request: RoleMutationRequest,
): Promise<Role> {
  const response = await apiClient.fetch<{ readonly data: unknown }>(rolePath(roleId), {
    method: 'PATCH',
    body: request,
  });
  try {
    return roleMutationResponseSchema.parse(response).data;
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/** Deletes a custom role and validates the acknowledgement. */
export async function deleteAdminRole(
  apiClient: ApiClient,
  roleId: string,
): Promise<{ readonly id: string; readonly deleted: true }> {
  const response = await apiClient.fetch<{ readonly data: unknown }>(rolePath(roleId), {
    method: 'DELETE',
  });
  try {
    return deleteRoleResponseSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/** Fetches and strictly parses the managed-domain list. */
export async function fetchAdminDomains(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<ManagedDomain[]> {
  const response = await apiClient.fetch<{ readonly data: unknown }>(
    '/api/v1/admin/domains',
    signal === undefined ? {} : { signal },
  );
  try {
    return managedDomainListResponseSchema.parse(response.data).items;
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

export function adminDomainsQuery() {
  const apiClient = useApiClient();
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: adminQueryKeys.domains(session?.userId ?? 'anonymous'),
    queryFn: ({ signal }) => fetchAdminDomains(apiClient, signal),
    staleTime: 0,
    enabled: session !== undefined && session !== null,
  });
}

/** Adds one normalized managed domain and validates the returned projection. */
export async function createManagedDomain(
  apiClient: ApiClient,
  name: string,
): Promise<ManagedDomain> {
  const response = await apiClient.fetch<{ readonly data: unknown }>('/api/v1/admin/domains', {
    method: 'POST',
    body: { name },
  });
  try {
    return managedDomainSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/** Performs the Phase 1 operator-confirmation verification action. */
export async function verifyManagedDomain(
  apiClient: ApiClient,
  domainId: string,
): Promise<{ readonly verified: true; readonly domain: string }> {
  const response = await apiClient.fetch<{ readonly data: unknown }>(
    `${managedDomainPath(domainId)}/verify`,
    { method: 'POST', body: {} },
  );
  try {
    return verifyManagedDomainResponseSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/** Deletes one managed domain and validates the delete acknowledgement. */
export async function deleteManagedDomain(
  apiClient: ApiClient,
  domainId: string,
): Promise<{ readonly id: string; readonly deleted: true }> {
  const response = await apiClient.fetch<{ readonly data: unknown }>(managedDomainPath(domainId), {
    method: 'DELETE',
  });
  try {
    return deleteManagedDomainResponseSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/**
 * Fetcher for one audit-events page. Parsed through the contracts schema.
 *
 * Fix pass (f): the ApiClient itself produces INVALID_RESPONSE only for a
 * non-JSON body — THIS wrapper is the detection point for schema-invalid
 * JSON (a 2xx body that parses as JSON but does not match
 * `auditEventListResponseSchema`). Without it a contract drift surfaces
 * as a raw ZodError. Same convention as the compose fetcher
 * (CAP-044 Slice 1 fix (f), mailbox-queries.ts): one stable code, status
 * 0 (there is no HTTP status to attribute to a client-side shape
 * mismatch).
 */
export async function fetchAuditEventsPage(
  apiClient: ApiClient,
  filters: AuditEventFilterInput,
  cursor?: string,
): Promise<AuditEventListResponse> {
  const response = await apiClient.fetch<{
    readonly data: AuditEventListResponse;
  }>(auditEventsPath(filters, cursor));
  try {
    return auditEventListResponseSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/**
 * Infinite query for the audit trail. Mirrors
 * `mailboxMessagesInfiniteQuery`: `getNextPageParam` hands the page's
 * signed `nextCursor` to the next fetch; `fetchNextPage` accumulates rows
 * across pages via `pages.flatMap` in the component. A 403
 * PERMISSION_DENIED (member, D-CAP-044-D) or a 400 INVALID_CURSOR
 * (R-API-005) surfaces through `error` like every failure — queries do
 * not retry (App.tsx sets `retry: false`), so a denied member produces
 * exactly one request, never a loop.
 */
export function auditEventsInfiniteQuery(filters: AuditEventFilterInput) {
  const apiClient = useApiClient();
  // Fix (a): the key is scoped to the signed-in user's id. 'anonymous'
  // is the never-fetched pre-session placeholder (see `enabled` — the
  // useAdminNavProbe precedent).
  const session = authSessionQuery().data;
  return useInfiniteQuery({
    queryKey: adminQueryKeys.auditEvents(session?.userId ?? 'anonymous', filters),
    queryFn: ({ pageParam }) => fetchAuditEventsPage(apiClient, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
    enabled: session !== undefined && session !== null,
  });
}

// ---------------------------------------------------------------------------
// CAP-044 Slice 3 (AC 19): the users list read.
// ---------------------------------------------------------------------------

/**
 * Builds the request path for one users page. The users list has no
 * filters (keyset ordering only), so the only param is the cursor.
 */
export function usersPath(cursor?: string): string {
  if (cursor === undefined || cursor === '') {
    return '/api/v1/admin/users';
  }
  return `/api/v1/admin/users?cursor=${encodeURIComponent(cursor)}`;
}

/**
 * Fetcher for one users page. Parsed through the contracts schema, with
 * the same INVALID_RESPONSE wrap as `fetchAuditEventsPage` (fix pass (f)
 * convention): a 2xx body that does not match `userListResponseSchema`
 * surfaces as one stable code, status 0.
 */
export async function fetchUsersPage(
  apiClient: ApiClient,
  cursor?: string,
): Promise<UserListResponse> {
  const response = await apiClient.fetch<{
    readonly data: UserListResponse;
  }>(usersPath(cursor));
  try {
    return userListResponseSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

/**
 * Infinite query for the users list. Same contract as
 * `auditEventsInfiniteQuery`: cursor is opaque, pages accumulate via
 * `pages.flatMap`, and a 403 PERMISSION_DENIED (member) or 400
 * INVALID_CURSOR surfaces through `error` — queries do not retry, so a
 * denied member produces exactly one request.
 */
export function usersInfiniteQuery() {
  const apiClient = useApiClient();
  // Fix (a): userId-scoped key ('anonymous' is the never-fetched
  // pre-session placeholder — see `enabled`).
  const session = authSessionQuery().data;
  return useInfiniteQuery({
    queryKey: adminQueryKeys.users(session?.userId ?? 'anonymous'),
    queryFn: ({ pageParam }) => fetchUsersPage(apiClient, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
    enabled: session !== undefined && session !== null,
  });
}

// ---------------------------------------------------------------------------
// CAP-044 Slice 3 (AC 20): the connections read + the audited reveal.
//
// LOCAL schemas — models of the LIVE CAP-025/CAP-040 wire shapes emitted
// by apps/worker/src/http/routes/admin-webhooks.ts. These endpoints have
// no contracts-package schema yet (they predate the contracts-first
// convention); promoting them is an orchestrator decision recorded in
// the Slice 3 report, not a unilateral edit here.
// ---------------------------------------------------------------------------

/** One provider-connection row (camelCase wire form, admin-webhooks.ts). */
export const adminConnectionSchema = z.object({
  id: z.string().min(1),
  providerKey: z.string().min(1),
  label: z.string(),
  status: z.string().min(1),
  webhookConfigured: z.boolean(),
  webhookUrl: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type AdminConnection = z.infer<typeof adminConnectionSchema>;

const adminConnectionListSchema = z.object({
  items: z.array(adminConnectionSchema),
});

/**
 * One webhook-delivery row (snake_case wire form — the CAP-025 endpoint
 * returns the repository rows as stored).
 */
export const webhookEventDeliverySchema = z.object({
  id: z.string().min(1),
  connection_id: z.string().min(1),
  event_type: z.string().min(1),
  message_id: z.string().nullable(),
  status: z.string().min(1),
  created_at: z.string().min(1),
});

export type WebhookEventDelivery = z.infer<typeof webhookEventDeliverySchema>;

const webhookEventDeliveryListSchema = z.object({
  items: z.array(webhookEventDeliverySchema),
});

/** The reveal response — the ONLY surface that ever carries the secret. */
export const webhookSecretRevealSchema = z.object({
  id: z.string().min(1),
  providerKey: z.string().min(1),
  label: z.string(),
  webhookSecret: z.string().min(1),
});

export type WebhookSecretReveal = z.infer<typeof webhookSecretRevealSchema>;

/**
 * Fetches the connections list. Same INVALID_RESPONSE wrap convention:
 * a 2xx body that does not match the local schema is one stable code.
 */
export async function fetchAdminConnections(apiClient: ApiClient): Promise<AdminConnection[]> {
  const response = await apiClient.fetch<{
    readonly data: unknown;
  }>('/api/v1/admin/connections');
  try {
    return adminConnectionListSchema.parse(response.data).items;
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

export function adminConnectionsQuery() {
  const apiClient = useApiClient();
  // Fix (a): userId-scoped key ('anonymous' is the never-fetched
  // pre-session placeholder — see `enabled`).
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: adminQueryKeys.connections(session?.userId ?? 'anonymous'),
    queryFn: () => fetchAdminConnections(apiClient),
    staleTime: 0,
    enabled: session !== undefined && session !== null,
  });
}

/**
 * Fetches the webhook-delivery list (newest first, server-truncated).
 */
export async function fetchWebhookEventDeliveries(
  apiClient: ApiClient,
): Promise<WebhookEventDelivery[]> {
  const response = await apiClient.fetch<{
    readonly data: unknown;
  }>('/api/v1/admin/webhook-events');
  try {
    return webhookEventDeliveryListSchema.parse(response.data).items;
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

export function webhookEventsQuery() {
  const apiClient = useApiClient();
  // Fix (a): userId-scoped key ('anonymous' is the never-fetched
  // pre-session placeholder — see `enabled`).
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: adminQueryKeys.webhookEvents(session?.userId ?? 'anonymous'),
    queryFn: () => fetchWebhookEventDeliveries(apiClient),
    staleTime: 0,
    enabled: session !== undefined && session !== null,
  });
}

/**
 * POST /api/v1/admin/connections/:id/webhook-secret/reveal.
 *
 * R-SECRET-003: the returned value is displayed ONCE by
 * ConnectionsPage behind a confirm dialog and is never logged or
 * persisted. This module only transports it; the two places it briefly
 * exists are the caller's component-local React state and the
 * mutation's TanStack MutationCache entry, which the caller collects
 * immediately on completion/unmount (`gcTime: 0` — fix (f)) — so the
 * resolved secret is NOT retained in any query or mutation cache past
 * the dialog's lifetime. Every server-side call is audited
 * (`webhook_secret.reveal`, R-AUDIT-001); the confirm dialog exists so
 * the operator makes that audit row deliberately.
 */
export async function revealWebhookSecret(
  apiClient: ApiClient,
  connectionId: string,
): Promise<WebhookSecretReveal> {
  const response = await apiClient.fetch<{
    readonly data: unknown;
  }>(`/api/v1/admin/connections/${encodeURIComponent(connectionId)}/webhook-secret/reveal`, {
    method: 'POST',
  });
  try {
    return webhookSecretRevealSchema.parse(response.data);
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

// ---------------------------------------------------------------------------
// CAP-044 Slice 3 amendment item 1 (D-CAP-044-K): the AppNav probe.
// ---------------------------------------------------------------------------

/**
 * The AppNav authorization probe. One `GET /api/v1/admin/audit-events?limit=1`:
 * 200 → the "Admin" link renders; 403 PERMISSION_DENIED or any error →
 * nothing. The probe is the client's ONLY admin-visibility signal — the
 * session descriptor carries no role/permission (D-CAP-044-D).
 *
 * This is a client-side VISIBILITY cache, not an authorization check:
 * the server re-reads `user_roles` on every request (R-AUTHZ-002), so a
 * mid-session role grant is effective server-side immediately — only
 * this link lags, until the next page reload. (A mid-session REVOCATION
 * hides nothing: every admin request behind the link still 403s.)
 *
 * - `retry: false` + `retryOnMount: false` + `staleTime: Infinity` +
 *   `gcTime: Infinity`: exactly ONE probe request per session for every
 *   outcome. `retryOnMount` matters because a DENIED probe (403) is an
 *   errored query, and TanStack refetches errored queries on every
 *   observer remount by default — AppNav remounts on every mailbox
 *   navigation, which would turn "one 403 per session" into one per
 *   route change. `gcTime: Infinity` keeps the unobserved entry alive
 *   (the default ~5 min GC would let the link vanish, then pop back
 *   with a fresh probe on return), so the verdict stays stable across
 *   route changes and long stays elsewhere.
 * - `enabled`: no probe fires for an unauthenticated or loading session,
 *   so the login screen and the logged-out shell stay request-free.
 *   The key carries the userId so a different user after re-login
 *   probes fresh (sign-out nulls only the session entry — fix (a)).
 */
export function useAdminNavProbe() {
  const apiClient = useApiClient();
  const sessionQuery = authSessionQuery();
  const session = sessionQuery.data;
  return useQuery({
    queryKey: adminQueryKeys.navProbe(session?.userId ?? 'anonymous'),
    queryFn: async (): Promise<boolean> => {
      // The payload is irrelevant — the probe tests AUTHORIZATION, not
      // data — so the body is not parsed against the audit schema. Any
      // non-2xx throws ApiError and lands in `error` → no link.
      await apiClient.fetch('/api/v1/admin/audit-events?limit=1');
      return true;
    },
    enabled: session !== undefined && session !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    retryOnMount: false,
    gcTime: Number.POSITIVE_INFINITY,
  });
}
