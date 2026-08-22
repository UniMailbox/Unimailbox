// admin-webhooks.worker.test.ts — CAP-025 admin webhook events view.
//
// Worker-pool tests for GET /admin/webhook-events and GET /admin/connections.
// Uses SELF.fetch to exercise the full request pipeline.
//
// Covers:
// - Admin can list webhook events (with seeded delivery row).
// - Admin can list connections (with seeded connection + webhook secret/URL).
// - Non-admin (member role) → 403 PERMISSION_DENIED.
// - Unauthenticated → 401 AUTHENTICATION_REQUIRED.
// - Empty list → 200 with items: [].

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

// Helper: complete setup + seed the permissions the tests need.
// administrator role gets webhook_event.read + provider.sync; member role
// does not.
async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    // Permissions
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('webhook_event.read', 'webhook_event.read', 'Read webhook events', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('provider.sync', 'provider.sync', 'Sync provider connection state', datetime('now'))`,
    ),
    // Roles
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    // administrator → webhook_event.read + provider.sync
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'webhook_event.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'provider.sync', datetime('now'))`,
    ),
  ]);
}

// Helper: create an admin user, return their id + access token.
async function createAdminUser(): Promise<{ userId: string; accessToken: string }> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('adminPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      'admin@example.com',
      'Admin User',
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'administrator', ?)`,
    ).bind(userId, now),
  ]);

  const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'adminPassword123',
    }),
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'test-admin-login-' + crypto.randomUUID(),
    },
  });

  const body = await response.json();
  return { userId, accessToken: body.data.accessToken };
}

// Helper: create a member user (no webhook_event.read), return access token.
async function createMemberUser(): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('memberPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      'member@example.com',
      'Member User',
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'member', ?)`,
    ).bind(userId, now),
  ]);

  const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'member@example.com',
      password: 'memberPassword123',
    }),
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'test-member-login-' + crypto.randomUUID(),
    },
  });

  const body = await response.json();
  return body.data.accessToken;
}

// Helper: seed a provider_connection row. encrypted_credentials row is a
// required FK stub. Returns the connectionId.
async function seedProviderConnection(
  webhookSecret: string | null = 'test-secret-64-hex-chars-padding-padding-padding-padd',
): Promise<string> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const credentialId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, ?, 1, X'00', X'000000000000000000000000', X'00000000000000000000000000000000', ?, ?)`,
    ).bind(credentialId, `cred-${connectionId}`, now, now),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, webhook_secret, created_at, updated_at)
       VALUES (?, 'brevo', ?, ?, 'active', ?, ?, ?)`,
    ).bind(connectionId, `conn-${connectionId}`, credentialId, webhookSecret, now, now),
  ]);

  return connectionId;
}

// Helper: seed a webhook_deliveries row for the given connectionId.
async function seedWebhookDelivery(connectionId: string): Promise<string> {
  const deliveryId = crypto.randomUUID();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  await env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, connection_id, event_type, raw_payload, message_id, status, created_at)
     VALUES (?, ?, 'delivered', '{}', NULL, 'processed', ?)`,
  )
    .bind(deliveryId, connectionId, now)
    .run();

  return deliveryId;
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/webhook-events
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/webhook-events', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('admin can list webhook events', async () => {
    const connectionId = await seedProviderConnection();
    const deliveryId = await seedWebhookDelivery(connectionId);

    const response = await SELF.fetch('http://localhost/api/v1/admin/webhook-events', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveProperty('items');
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toHaveProperty('id', deliveryId);
    expect(body.data.items[0]).toHaveProperty('connection_id', connectionId);
    expect(body.data.items[0]).toHaveProperty('event_type', 'delivered');
    expect(body.data.items[0]).toHaveProperty('status', 'processed');
    // raw_payload must not be exposed in the list view.
    expect(body.data.items[0]).not.toHaveProperty('raw_payload');
  });

  it('returns empty items array when no deliveries exist', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/webhook-events', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([]);
  });

  it('returns 403 for non-admin (member role)', async () => {
    const memberToken = await createMemberUser();

    const response = await SELF.fetch('http://localhost/api/v1/admin/webhook-events', {
      headers: { Authorization: `Bearer ${memberToken}` },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/webhook-events');

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/connections
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/connections', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('admin can list connections with webhook URL and configured boolean', async () => {
    // CAP-040 / R-SECRET-003: the list endpoint must NOT return
    // `webhookSecret` — the secret value is only returned by the
    // explicit reveal endpoint. The list surfaces `webhookConfigured`
    // (boolean) + `webhookUrl` so the operator can copy the URL into
    // the provider dashboard without a second round-trip.
    const connectionId = await seedProviderConnection('my-webhook-secret');

    const response = await SELF.fetch('http://localhost/api/v1/admin/connections', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveProperty('items');
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toHaveProperty('id', connectionId);
    expect(body.data.items[0]).toHaveProperty('providerKey', 'brevo');
    expect(body.data.items[0]).toHaveProperty('status', 'active');
    // Secret must not be present in the list (R-SECRET-003).
    expect(body.data.items[0]).not.toHaveProperty('webhookSecret');
    expect(body.data.items[0]).toHaveProperty('webhookConfigured', true);
    expect(body.data.items[0]).toHaveProperty(
      'webhookUrl',
      `/api/v1/webhooks/brevo/${connectionId}`,
    );
  });

  it('returns null webhookUrl when connection has no webhook secret', async () => {
    await seedProviderConnection(null);

    const response = await SELF.fetch('http://localhost/api/v1/admin/connections', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    // CAP-040 / R-SECRET-003: list does not include the secret column.
    expect(body.data.items[0]).not.toHaveProperty('webhookSecret');
    expect(body.data.items[0]).toHaveProperty('webhookConfigured', false);
    expect(body.data.items[0]).toHaveProperty('webhookUrl', null);
  });

  it('returns empty items array when no connections exist', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/connections', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([]);
  });

  it('returns 403 for non-admin (member role)', async () => {
    const memberToken = await createMemberUser();

    const response = await SELF.fetch('http://localhost/api/v1/admin/connections', {
      headers: { Authorization: `Bearer ${memberToken}` },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/connections');

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/connections/:id/webhook-secret/reveal — CAP-040.
// ---------------------------------------------------------------------------

describe('POST /api/v1/admin/connections/:id/webhook-secret/reveal', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  it('returns the secret and writes a webhook_secret.reveal audit row', async () => {
    // CAP-040 / R-SECRET-003: the reveal endpoint is the ONLY API
    // surface that returns webhook_secret material, and every call
    // writes an audit row (R-AUDIT-001) so the secret cannot be
    // exfiltrated with a leaked token without an audit trail.
    const connectionId = await seedProviderConnection('super-secret-value');

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/connections/${connectionId}/webhook-secret/reveal`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'reveal-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({
      id: connectionId,
      providerKey: 'brevo',
      label: `conn-${connectionId}`,
      webhookSecret: 'super-secret-value',
    });

    // R-AUDIT-001: every reveal writes an audit row. The actor is the
    // authenticated user; the resource is the connection; the metadata
    // carries the connectionId + providerKey but NEVER the secret.
    const audit = await env.DB.prepare(
      `SELECT actor_user_id, resource_type, resource_id, metadata, request_id
         FROM audit_events WHERE action = 'webhook_secret.reveal'`,
    ).first<{
      actor_user_id: string | null;
      resource_type: string;
      resource_id: string | null;
      metadata: string | null;
      request_id: string | null;
    }>();
    expect(audit).not.toBeNull();
    expect(audit?.resource_type).toBe('provider_connection');
    expect(audit?.resource_id).toBe(connectionId);
    expect(audit?.actor_user_id).not.toBeNull();
    // requestId is the correlation UUID the request-id middleware
    // stamped on this HTTP request — propagates into the audit row so
    // the operator can correlate the reveal with logs and traces.
    expect(audit?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const meta = JSON.parse(audit?.metadata ?? '{}') as {
      connectionId: string;
      providerKey: string;
    };
    expect(meta.connectionId).toBe(connectionId);
    expect(meta.providerKey).toBe('brevo');
    // Defensive: the metadata MUST NOT carry the secret value itself.
    expect(JSON.stringify(meta)).not.toContain('super-secret-value');
  });

  it('returns 404 when connection does not exist', async () => {
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/connections/${crypto.randomUUID()}/webhook-secret/reveal`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'reveal-404-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('PROVIDER_CONNECTION_NOT_FOUND');
  });

  it('returns 401 when unauthenticated', async () => {
    const connectionId = await seedProviderConnection();
    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/connections/${connectionId}/webhook-secret/reveal`,
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'reveal-401-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 for a member user (no provider.sync permission)', async () => {
    // CAP-040 / R-SECRET-003: the reveal endpoint returns secret material
    // — the most dangerous surface — so it must reject non-admins with
    // 403, not just trust the parent list endpoint's analogue. The
    // requirePermission('provider.sync') middleware is shared with the
    // list endpoints, but the most sensitive surface deserves its own
    // 403 assertion rather than trusting-by-analogy.
    const memberToken = await createMemberUser();
    const connectionId = await seedProviderConnection();

    const response = await SELF.fetch(
      `http://localhost/api/v1/admin/connections/${connectionId}/webhook-secret/reveal`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberToken}`,
          'Idempotency-Key': 'reveal-403-' + crypto.randomUUID(),
        },
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');

    // Defensive: a denied reveal must NOT write the audit row.
    // R-AUDIT-001 audits successful reveals; denied reveals should not
    // clutter the audit trail (the rejection is logged at the auth layer).
    const audit = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM audit_events
         WHERE action = 'webhook_secret.reveal' AND resource_id = ?`,
    )
      .bind(connectionId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });
});
