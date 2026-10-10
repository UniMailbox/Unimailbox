/**
 * @unimailbox/test-kit — recorder stubs for external I/O.
 *
 * `stubOutboundAdapter()` — implements the full `OutboundProviderAdapter`
 * contract from `packages/contracts`: `key`, `validateConnection`, and
 * `send(ctx, msg)`. `send` records a `SendProviderMessage` per call and
 * returns a deterministic `ProviderSendResult`. Tests assert on `.calls`.
 * Real adapters land in `apps/worker/src/integrations/providers/*` (Phase 1).
 *
 * `stubFetch()` — drop-in replacement for the global `fetch` that returns
 * a canned `Response` per URL. Tests register handlers with `.on(url,
 * response)` or `.on(url, status, body)`. URLs are normalised through
 * `new URL(...).toString()` on both registration and call so that `Request`
 * normalisations (trailing slash, query order) don't trip the matcher.
 * Unhandled URLs throw — that's the point: an undeclared outbound HTTP call
 * is a test defect.
 *
 * Mocking rules (.claude/rules/testing.md §Mocking): never mock D1/R2/KV/Queue.
 * Do mock provider HTTP at the adapter or fetch boundary.
 */
import type {
  OutboundProviderAdapter,
  ProviderKey,
  ProviderRuntimeContext,
  ProviderSendResult,
  SendProviderMessage,
} from '@unimailbox/contracts';
import { parseProviderKey } from '@unimailbox/contracts';

export interface RecordedSend {
  readonly ctx: ProviderRuntimeContext;
  readonly msg: SendProviderMessage;
  /** Zero-based index of this send within the stub's lifetime. */
  readonly sequence: number;
}

export interface StubOutboundAdapter extends OutboundProviderAdapter {
  readonly calls: ReadonlyArray<RecordedSend>;
  /**
   * Override the deterministic providerMessageId the stub returns. Useful
   * for tests that need to assert on a specific provider id (e.g. webhook
   * processing).
   */
  setNextProviderMessageId(value: string): void;
  /**
   * Override the deterministic acceptedAt timestamp the stub returns.
   * Defaults to `'2026-01-01T00:00:00.000Z'`.
   */
  setNextAcceptedAt(value: string): void;
}

function defaultCtx(): ProviderRuntimeContext {
  return { env: {} };
}

export function stubOutboundAdapter(providerKey: string = 'stub'): StubOutboundAdapter {
  const calls: RecordedSend[] = [];
  let nextProviderMessageId = 'stub-provider-message-1';
  let nextAcceptedAt = '2026-01-01T00:00:00.000Z';
  const key: ProviderKey = parseProviderKey(providerKey);

  const adapter: OutboundProviderAdapter = {
    key,
    async validateConnection(_ctx: ProviderRuntimeContext): Promise<void> {
      // No-op: the stub has no remote to validate. Real adapters ping the
      // provider's auth endpoint.
    },
    async send(ctx: ProviderRuntimeContext, msg: SendProviderMessage): Promise<ProviderSendResult> {
      calls.push({ ctx, msg, sequence: calls.length });
      return {
        providerMessageId: nextProviderMessageId,
        acceptedAt: nextAcceptedAt,
      };
    },
  };

  return {
    ...adapter,
    get calls(): ReadonlyArray<RecordedSend> {
      return calls;
    },
    setNextProviderMessageId(value: string): void {
      nextProviderMessageId = value;
    },
    setNextAcceptedAt(value: string): void {
      nextAcceptedAt = value;
    },
  };
}

// Quiet unused-symbol warnings for the helper reserved for future tests.
void defaultCtx;

export type FetchHandler = string | number | Response | (() => Response | Promise<Response>);

export interface StubFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Register a canned response for a URL. URL is normalised before lookup. */
  on(url: string, handler: FetchHandler): void;
  /** Inspect URLs that have been requested (in order, normalised). */
  readonly requestedUrls: ReadonlyArray<string>;
  reset(): void;
}

const normaliseUrl = (raw: string): string => new URL(raw).toString();

export function stubFetch(): StubFetch {
  const handlers = new Map<string, FetchHandler>();
  const requestedUrls: string[] = [];

  const buildResponse = (handler: FetchHandler): Response | Promise<Response> => {
    if (typeof handler === 'function') return handler();
    if (handler instanceof Response) return handler;
    if (typeof handler === 'number') return new Response(null, { status: handler });
    return new Response(handler, { status: 200 });
  };

  const fn = (async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = normaliseUrl(raw);
    requestedUrls.push(url);
    const handler = handlers.get(url);
    if (!handler) {
      throw new Error(`stubFetch: no handler registered for URL ${url}`);
    }
    return buildResponse(handler);
  }) as StubFetch;

  fn.on = (url: string, handler: FetchHandler): void => {
    handlers.set(normaliseUrl(url), handler);
  };
  Object.defineProperty(fn, 'requestedUrls', { value: requestedUrls });
  fn.reset = (): void => {
    handlers.clear();
    requestedUrls.length = 0;
  };
  return fn;
}
