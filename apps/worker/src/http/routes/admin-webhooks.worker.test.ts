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
// administrator role gets webhook_event.read; member role does not.
async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    // Permissions
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('webhook_event.read', 'webhook_event.read', 'Read webhook events', datetime('now'))`,
    ),
    // Roles
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    // administrator → webhook_event.read
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'webhook_event.read', datetime('now'))`,
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
  ).bind(deliveryId, connectionId, now).run();

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

  it('admin can list connections with webhook URL and secret', async () => {
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
    expect(body.data.items[0]).toHaveProperty('webhookSecret', 'my-webhook-secret');
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
    expect(body.data.items[0]).toHaveProperty('webhookSecret', null);
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
