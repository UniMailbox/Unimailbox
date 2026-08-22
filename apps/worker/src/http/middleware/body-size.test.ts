// body-size.test.ts — unit tests for enforceBodySize middleware.
// Covers AC5-AC8 from CAP-031's acceptance criteria.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { enforceBodySize } from './body-size';
import { errorMiddleware } from './error';
import { logger } from '../../platform/logger';
import type { AppEnv } from '../../platform/env';

// Build a minimal Hono app that mounts enforceBodySize and a downstream
// handler that echoes the body back. Lets us assert: did the handler
// ever run? did the body bytes reach it intact?
function buildApp(maxBytes: number) {
  const app = new Hono<AppEnv>();
  // Install the production error middleware so thrown DomainErrors map
  // to their declared httpStatus (413 BODY_TOO_LARGE), matching the
  // request pipeline end-to-end.
  app.onError(errorMiddleware);
  app.use('*', enforceBodySize(maxBytes));
  app.post('/echo', async (c) => {
    const body = await c.req.text();
    return c.json({ data: { received: body, length: body.length } });
  });
  app.post('/webhook/echo', async (c) => {
    const body = await c.req.text();
    return c.json({ data: { webhookReceived: body, length: body.length } });
  });
  return app;
}

describe('enforceBodySize', () => {
  describe('R-API-005 / AC5', () => {
    it('returns 413 BODY_TOO_LARGE when Content-Length exceeds the limit', async () => {
      const app = buildApp(1024);
      const response = await app.request('http://localhost/echo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '1048577',
        },
        body: '{"good": true}',
      });
      expect(response.status).toBe(413);
      const json = (await response.json()) as { error: { code: string } };
      expect(json.error.code).toBe('BODY_TOO_LARGE');
    });
  });

  describe('AC6', () => {
    it('returns 413 when no Content-Length is provided and the raw body exceeds the limit', async () => {
      const app = buildApp(1024);
      const bigBody = 'x'.repeat(2048);
      const response = await app.request('http://localhost/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bigBody,
      });
      expect(response.status).toBe(413);
      const json = (await response.json()) as { error: { code: string } };
      expect(json.error.code).toBe('BODY_TOO_LARGE');
    });
  });

  describe('AC7', () => {
    it('passes through to the next middleware when the body is within the limit', async () => {
      const app = buildApp(1024 * 1024);
      const response = await app.request('http://localhost/echo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '1024',
        },
        body: '{"hello":"world"}',
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { data: { received: string } };
      expect(json.data.received).toBe('{"hello":"world"}');
    });
  });

  describe('R-LOG-001 / AC8', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let infoSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('emits no log line on over-limit rejection (body bytes never logged)', async () => {
      const app = buildApp(128);
      const bigBody = 'Y'.repeat(256);
      const response = await app.request('http://localhost/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bigBody,
      });
      expect(response.status).toBe(413);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});

// AC9 — webhook exemption — is covered end-to-end in the worker tests
// (see http/routes/webhooks.worker.test.ts, which mounts the webhook
// router without enforceBodySize and proves a 2 MB payload reaches the
// signature-verification path). This unit-test layer cannot fully
// isolate that, because the webhook exemption is a router-wiring
// decision (mount the middleware on `/api/v1/*` parent but not on
// `/api/v1/webhooks/*`). The worker tests are the authoritative proof.
