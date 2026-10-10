# CAP-018 + CAP-019 — Registration keys + User registration/login/session

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## CAP-018 — Registration keys

Admin creates invite codes. New users register with a code.

### Scope

- **New migration** `0004_registration_keys.sql` — `registration_keys` table.
- **Registration key repository** in onboarding (`registration-key-repository.ts`):
  - `createRegistrationKey(db, input)` — generate random code, hash with SHA-256, store hash.
  - `findKeyByCodeHash(db, hash)` — look up by hash.
  - `incrementKeyUsage(db, keyId)` — atomically increment `used_count`.
- **`POST /api/v1/admin/invite-codes`** — admin-only (requires `requirePermission('user.manage')` + authn middleware). Creates a key, returns plaintext code (shown once).
- **`GET /api/v1/admin/invite-codes`** — list keys (id, maxUses, usedCount, expiresAt, revokedAt, createdAt — NOT the code or hash).

### CAP-018 Acceptance criteria

- [ ] 1. Admin can create a registration key → 200 with `{ code, id, maxUses, expiresAt }`.
- [ ] 2. Code is 64 hex chars (32 random bytes). Only the hash is stored.
- [ ] 3. Admin can list keys (without seeing codes).
- [ ] 4. Non-admin → 403.
- [ ] 5. Unauthenticated → 401.

---

## CAP-019 — User registration + login + session

Users register with a key, login with email+password, get access/refresh tokens.

### Scope

- **`verifyPassword`** in `platform/crypto.ts` — PBKDF2 verify: hash input with stored salt+iterations, constant-time compare with stored hash.
- **Identity module additions**:
  - `findUserByEmail(db, email)` — look up by email (NOCASE).
  - `createSession(db, input)` — insert into sessions table.
  - `findSessionByRefreshToken(db, hash)` — look up session.
- **Auth middleware** (`http/middleware/authn.ts`) — reads `Authorization: Bearer <accessToken>`, looks up in CACHE KV (`auth:{token}` → `{ userId }`), sets `c.set('userId', userId)`. Applied globally.
- **`POST /api/v1/auth/register`** — body: `{ code, email, password, displayName? }`. Validates code → creates user with PBKDF2 → assigns 'member' role → increments key usage. D1 batch (atomic).
- **`POST /api/v1/auth/login`** — body: `{ email, password }`. Finds user → verifies password → creates access token (KV, 15-min TTL) + refresh token (sessions table, 30-day) → returns `{ accessToken, refreshToken, user }`.
- **`POST /api/v1/auth/refresh`** — body: `{ refreshToken }`. Validates refresh token → creates new access token.
- **`GET /api/v1/auth/me`** — requires authn → returns current user info.
- **Router update** — mount authn middleware globally (after setupGate), mount auth routes.

### CAP-019 Acceptance criteria

- [ ] 1. Register with valid code + email + password → 200 with `{ user: { id, email, displayName } }`.
- [ ] 2. Register with invalid code → 409.
- [ ] 3. Register with taken email → 409.
- [ ] 4. Login with correct credentials → 200 with `{ accessToken, refreshToken, user }`.
- [ ] 5. Login with wrong password → 401.
- [ ] 6. Authenticated request to protected route → succeeds (userId set by authn).
- [ ] 7. `GET /api/v1/auth/me` with valid token → 200 with user info.
- [ ] 8. `GET /api/v1/auth/me` without token → 401.
- [ ] 9. `verifyPassword` unit-tested.
- [ ] 10. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 11. `pnpm scaffold doctor` exits 0 (10/10).

---

## File ownership

| Agent | Owns |
|---|---|
| implementer | `migrations/0004_registration_keys.sql` (new) |
| implementer | `migrations/0004_registration_keys.verify.sql` (new) |
| implementer | `apps/worker/src/database/schema/onboarding.ts` (add registration_keys) |
| implementer | `apps/worker/src/database/schema-version.ts` (bump to '0004') |
| implementer | `apps/worker/src/platform/crypto.ts` (add verifyPassword) |
| implementer | `apps/worker/src/platform/crypto.test.ts` (add verifyPassword tests) |
| implementer | `apps/worker/src/modules/onboarding/registration-key-repository.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/modules/identity/user-repository.ts` (add findUserByEmail) |
| implementer | `apps/worker/src/modules/identity/session-repository.ts` (new) |
| implementer | `apps/worker/src/modules/identity/index.ts` |
| implementer | `apps/worker/src/http/middleware/authn.ts` (new) |
| implementer | `apps/worker/src/http/routes/auth.ts` (new — register, login, refresh, me) |
| implementer | `apps/worker/src/http/routes/admin.ts` (new — invite-codes CRUD) |
| implementer | `apps/worker/src/http/router.ts` (mount authn + auth/admin routes) |
| implementer | `packages/contracts/src/index.ts` (add request schemas) |
| implementer | `packages/contracts/src/index.test.ts` |
| implementer | `packages/test-kit/src/migrationsDb.ts` (add 0004 migration) |
| implementer | `apps/worker/src/http/routes/auth.worker.test.ts` (new) |
| implementer | `apps/worker/src/http/routes/admin-invite-codes.worker.test.ts` (new) |

## Reading list

- `work/active/CAP-018-019-registration/task.md` (this file)
- `.claude/rules/security.md` — §Authorization, §Passwords, §Idempotency
- `.claude/rules/architecture.md` — §Dependency direction, §API conventions
- `docs/rebuild/E-proposed-domain-model.md` — RegistrationKey interface
- `migrations/0001_initial.sql` — sessions table DDL (lines 97-108)
- `apps/worker/src/platform/crypto.ts` — hashPassword (add verifyPassword)
- `apps/worker/src/modules/identity/user-repository.ts` — createUser, getFirstUser
- `apps/worker/src/http/middleware/authz.ts` — requirePermission (reads c.get('userId'))
- `apps/worker/src/http/middleware/setup-session.ts` — middleware pattern
- `apps/worker/src/http/router.ts` — current router
- `packages/contracts/src/index.ts`

## Design guidance

### Migration (0004_registration_keys.sql)

```sql
CREATE TABLE IF NOT EXISTS registration_keys (
  id              TEXT PRIMARY KEY,
  code_hash       TEXT NOT NULL,
  role_id         TEXT REFERENCES roles(id) ON DELETE SET NULL,
  max_uses        INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count      INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,
  revoked_at      TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_registration_keys.sql');
```

### verifyPassword (platform/crypto.ts)

```typescript
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: stored.salt, iterations: stored.iterations, hash: 'SHA-256' },
    key, 256,
  );
  return constantTimeCompare(
    new Uint8Array(hashBuffer),
    stored.hash,
  );
}
```

Note: `constantTimeCompare` takes strings, but here we compare Uint8Arrays. Either convert to hex strings or add a byte-array variant.

### Auth middleware (http/middleware/authn.ts)

```typescript
export const authn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length);
    const data = await c.env.CACHE.get(`auth:${token}`);
    if (data) {
      const parsed = JSON.parse(data) as { userId: string };
      c.set('userId', parsed.userId);
    }
  }
  await next();
};
```

Applied globally — sets userId if valid token present, leaves unset otherwise. requirePermission handles 401/403.

### Login flow

```typescript
// 1. Find user
const user = await findUserByEmail(db, email);
if (!user) throw new DomainError({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', httpStatus: 401 });

// 2. Verify password
const storedHash: PasswordHash = { algorithm: user.password_algorithm, iterations: user.password_iterations, salt: new Uint8Array(user.password_salt), hash: new Uint8Array(user.password_hash) };
const valid = await verifyPassword(password, storedHash);
if (!valid) throw new DomainError({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', httpStatus: 401 });

// 3. Generate tokens
const accessToken = ids.uuid();
const refreshToken = ids.uuid();
const expiresAt = Math.floor(clock.now().getTime() / 1000) + 30 * 24 * 3600; // 30 days

// 4. Store access token in KV (15-min TTL)
await cache.put(`auth:${accessToken}`, JSON.stringify({ userId: user.id }), { expirationTtl: 900 });

// 5. Store session in D1 (refresh token hash)
await createSession(db, { id: ids.uuid(), userId: user.id, refreshTokenHash: hashToken(refreshToken), expiresAt, ... });

// 6. Return
return { accessToken, refreshToken, user: { id: user.id, email: user.email, displayName: user.displayName } };
```

### Router mounting

```typescript
router.use('*', requestId);
router.use('*', setupGate);
router.use('*', authn); // NEW — sets userId if authenticated

router.get('/', ...);
router.get('/healthz', ...);
router.route('/api/v1/setup', setupRoutes());
router.route('/api/v1/auth', authRoutes()); // NEW
router.route('/api/v1/admin', adminRoutes()); // NEW
```

### Registration code generation

```typescript
// Generate 32 random bytes → 64-char hex string
const codeBytes = crypto.getRandomValues(new Uint8Array(32));
const code = Array.from(codeBytes).map(b => b.toString(16).padStart(2, '0')).join('');
// Hash with SHA-256 for storage
const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
const codeHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
```

## Constraints

- Do not commit. No `any`. Never mock D1/KV.
- Auth tokens stored in CACHE KV with key prefix `auth:`. Setup tokens use `smoke:` prefix — no collision.
- Refresh token stored as SHA-256 hash in sessions table — never plaintext.
- `INVALID_CREDENTIALS` for both wrong email and wrong password (don't leak which).
- Registration and login endpoints are PUBLIC (no auth required, no requirePermission).
- Admin invite-codes endpoint requires authn + requirePermission('user.manage').
- Do CAP-018 first, then CAP-019.

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
