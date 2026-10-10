import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';
import { expireIdentityRecords } from './expire-identity-records';

beforeEach(resetAndMigrate);
const now = new Date('2026-10-09T00:00:00Z');

it('R-AUTH-003 preserves active sessions and unexpired idempotency records while bounding daily eviction', async () => {
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO users (id,email,status,password_algorithm,password_iterations,password_salt,password_hash)
      VALUES ('ttl-user','ttl@example.com','active','pbkdf2-sha256',100000,x'00',x'00')`),
    env.DB
      .prepare(`INSERT INTO sessions (id,user_id,refresh_token_hash,expires_at,revoked_at) VALUES
      ('expired','ttl-user','hash-expired',0,NULL),
      ('revoked','ttl-user','hash-revoked',2000000000,'2026-10-08 00:00:00'),
      ('active','ttl-user','hash-active',2000000000,NULL)`),
    env.DB.prepare(
      `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<1001)
      INSERT INTO idempotency_records (id,actor_id,operation,idempotency_key,request_hash,response_status,response_json,created_at,expires_at)
      SELECT 'expired-'||v,'ttl-user','test','key-'||v,?,200,'{}','2026-10-07 00:00:00','2026-10-08 00:00:00' FROM n`,
    ).bind('0'.repeat(64)),
    env.DB.prepare(
      `INSERT INTO idempotency_records (id,actor_id,operation,idempotency_key,request_hash,response_status,response_json,created_at,expires_at)
      VALUES ('fresh','ttl-user','test','fresh',?,200,'{}','2026-10-09 00:00:00','2026-10-10 00:00:00')`,
    ).bind('0'.repeat(64)),
  ]);
  await expireIdentityRecords(env.DB, now);
  expect((await env.DB.prepare('SELECT id FROM sessions').all()).results).toEqual([
    { id: 'active' },
  ]);
  expect(
    await env.DB.prepare('SELECT count(*) AS count FROM idempotency_records').first('count'),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT id FROM idempotency_records WHERE id='fresh'").first('id'),
  ).toBe('fresh');
  await expireIdentityRecords(env.DB, now);
  expect((await env.DB.prepare('SELECT id FROM idempotency_records').all()).results).toEqual([
    { id: 'fresh' },
  ]);
});
