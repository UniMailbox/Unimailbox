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
// D-CAP-044-D authorization note: the auth session descriptor carries NO
// role/permission signal (see features/auth/auth-queries.ts — Better Auth
// get-session returns user + session only), so the client cannot pre-hide
// the admin surface. Authorization is enforced SERVER-side
// (requirePermission('audit.read')); a member who navigates here receives
// 403 PERMISSION_DENIED, which the page renders as a not-authorized state
// (AC 14) rather than a crash. The nav-signal gap is reported to the
// orchestrator — widening the session endpoint is not this slice's call.
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  auditEventListResponseSchema,
  type AuditAction,
  type AuditEventListResponse,
} from '@unimailbox/contracts';
import type { ApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';

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
  // The key serializes the filters through the SAME path builder the
  // fetcher uses, so two filter sets that produce one URL produce one
  // cache entry — no parallel keys for identical requests.
  auditEvents: (filters: AuditEventFilterInput) =>
    [...adminQueryKeys.all, 'audit-events', auditEventsPath(filters)] as const,
};

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
  return useInfiniteQuery({
    queryKey: adminQueryKeys.auditEvents(filters),
    queryFn: ({ pageParam }) => fetchAuditEventsPage(apiClient, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  });
}
