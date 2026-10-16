/** Worker-only actor with an explicit analytics permission; no private mail. */
export async function seedResourceUsageActor(
  allowed: boolean,
  cache: { put(key: string, value: string, options?: { expirationTtl: number }): Promise<void> },
) {
  const { env } = await import('cloudflare:test');
  const { seedInboundMailbox } = await import('./inbound');
  const { ownerId } = await seedInboundMailbox();
  if (allowed)
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO permissions(id,key,description) VALUES ('analytics.read','analytics.read','Read analytics')",
      ),
      env.DB.prepare(
        "INSERT INTO roles(id,name,description,is_system) VALUES ('analytics-role','analytics-reader','Synthetic analytics reader',0)",
      ),
      env.DB.prepare(
        "INSERT INTO role_permissions(role_id,permission_id) VALUES ('analytics-role','analytics.read')",
      ),
      env.DB.prepare(
        "INSERT INTO user_roles(user_id,role_id,granted_at) VALUES (?,'analytics-role',datetime('now'))",
      ).bind(ownerId),
    ]);
  const token = crypto.randomUUID(),
    sessionId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at) VALUES (?,?,?,2000000000)',
  )
    .bind(sessionId, ownerId, crypto.randomUUID())
    .run();
  await cache.put(`auth:${token}`, JSON.stringify({ userId: ownerId, sessionId }), {
    expirationTtl: 900,
  });
  return token;
}
