import type { OperationResult } from '../platform/operation';
export function operationResponse(result: OperationResult, requestId?: string): Response {
  return new Response(result.responseJson === '' ? null : result.responseJson, {
    status: result.responseStatus,
    headers: { ...result.headers, ...(requestId ? { 'X-Request-Id': requestId } : {}) },
  });
}
