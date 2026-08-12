// HTTP entry — Hono app. CAP-001 stub.
// The composition root (`src/worker.ts`) is what the deployed bundle exports.
// This module owns the `fetch` handler only — see `buildRouter()` for routes.
import { Hono } from 'hono';
import { buildRouter } from '../http/router';
import { errorMiddleware } from '../http/middleware/error';
import type { AppEnv } from '../platform/env';

export const app: Hono<AppEnv> = new Hono<AppEnv>();
app.route('/', buildRouter());
app.onError(errorMiddleware);
