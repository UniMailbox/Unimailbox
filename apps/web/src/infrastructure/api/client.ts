// apps/web — API client stub.
// CAP-001 lays rails. Real fetch wrapper, retry, idempotency, and request-id
// propagation land with the inbox capability.
export interface ApiClient {
  readonly baseUrl: string;
}

export function createApiClient(baseUrl: string): ApiClient {
  return { baseUrl };
}

export {};