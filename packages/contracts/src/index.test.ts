// packages/contracts — unit test for the sample zod schemas.
// Proves the harness can round-trip a schema, surface a safeParse failure,
// and that the failed parse shape is stable for callers.
import { describe, expect, it } from 'vitest';
import {
  emailAddressSchema,
  uuidSchema,
  installationStepSchema,
  installationStateInfoSchema,
  setupClaimRequestSchema,
  setupPreflightResponseSchema,
  setupAdministratorRequestSchema,
  domainNameSchema,
  setupDomainRequestSchema,
  setupBrevoRequestSchema,
  permissionKeySchema,
  createInviteCodeRequestSchema,
  registerRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
} from './index';

describe('emailAddressSchema', () => {
  it('accepts a plain address', () => {
    const result = emailAddressSchema.parse('user@example.com');
    expect(result).toBe('user@example.com');
  });

  it('normalises to lowercase + trimmed form (R-DATA-001)', () => {
    const result = emailAddressSchema.parse('  USER@Example.COM ');
    expect(result).toBe('user@example.com');
  });

  it('rejects malformed addresses via safeParse', () => {
    const result = emailAddressSchema.safeParse('not-an-email');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      // stable shape: every issue carries a path + a code
      for (const issue of result.error.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.code).toBe('string');
      }
    }
  });

  it('rejects addresses longer than 254 chars', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(200)}.com`;
    const result = emailAddressSchema.safeParse(long);
    expect(result.success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts a uuid-shaped string', () => {
    const result = uuidSchema.parse('00000000-0000-4000-8000-000000000001');
    expect(result).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('rejects a non-uuid string', () => {
    const result = uuidSchema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
  });
});

describe('installationStepSchema', () => {
  it('accepts a valid step', () => {
    const result = installationStepSchema.parse('claim');
    expect(result).toBe('claim');
  });

  it('rejects an invalid step', () => {
    const result = installationStepSchema.safeParse('not-a-step');
    expect(result.success).toBe(false);
  });
});

describe('installationStateInfoSchema', () => {
  it('accepts a valid state', () => {
    const result = installationStateInfoSchema.parse({
      status: 'setup',
      currentStep: 'claim',
    });
    expect(result).toEqual({ status: 'setup', currentStep: 'claim' });
  });

  it('rejects an invalid status', () => {
    const result = installationStateInfoSchema.safeParse({
      status: 'unknown',
      currentStep: 'claim',
    });
    expect(result.success).toBe(false);
  });
});

describe('setupClaimRequestSchema', () => {
  it('accepts a valid token', () => {
    const result = setupClaimRequestSchema.parse({ token: 'my-token' });
    expect(result).toEqual({ token: 'my-token' });
  });

  it('rejects missing token via safeParse', () => {
    const result = setupClaimRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects empty token via safeParse', () => {
    const result = setupClaimRequestSchema.safeParse({ token: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('setupPreflightResponseSchema', () => {
  it('accepts a valid preflight response', () => {
    const result = setupPreflightResponseSchema.parse({
      bindings: {
        DB: true,
        ATTACHMENTS: true,
        SETUP_SESSION: true,
        CACHE: true,
        OUTBOUND: true,
        INSTALLATION_TOKEN: true,
        CREDENTIAL_ENCRYPTION_KEY: true,
      },
      schemaVersion: '0001',
    });
    expect(result).toEqual({
      bindings: {
        DB: true,
        ATTACHMENTS: true,
        SETUP_SESSION: true,
        CACHE: true,
        OUTBOUND: true,
        INSTALLATION_TOKEN: true,
        CREDENTIAL_ENCRYPTION_KEY: true,
      },
      schemaVersion: '0001',
    });
  });

  it('rejects non-boolean bindings via safeParse', () => {
    const result = setupPreflightResponseSchema.safeParse({
      bindings: { DB: 'true' },
      schemaVersion: '0001',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-string schemaVersion via safeParse', () => {
    const result = setupPreflightResponseSchema.safeParse({
      bindings: { DB: true },
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('setupAdministratorRequestSchema', () => {
  it('accepts a valid administrator request with displayName', () => {
    const result = setupAdministratorRequestSchema.parse({
      email: 'admin@example.com',
      password: 'securePassword123',
      displayName: 'Admin User',
    });
    expect(result).toEqual({
      email: 'admin@example.com',
      password: 'securePassword123',
      displayName: 'Admin User',
    });
  });

  it('accepts a valid administrator request without displayName', () => {
    const result = setupAdministratorRequestSchema.parse({
      email: 'admin@example.com',
      password: 'securePassword123',
    });
    expect(result).toEqual({
      email: 'admin@example.com',
      password: 'securePassword123',
      displayName: undefined,
    });
  });

  it('normalises email to lowercase and trimmed (R-DATA-001)', () => {
    const result = setupAdministratorRequestSchema.parse({
      email: '  ADMIN@Example.COM  ',
      password: 'securePassword123',
    });
    expect(result.email).toBe('admin@example.com');
  });

  it('rejects missing email via safeParse', () => {
    const result = setupAdministratorRequestSchema.safeParse({
      password: 'securePassword123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing password via safeParse', () => {
    const result = setupAdministratorRequestSchema.safeParse({
      email: 'admin@example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects password shorter than 8 characters via safeParse', () => {
    const result = setupAdministratorRequestSchema.safeParse({
      email: 'admin@example.com',
      password: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects password longer than 72 characters via safeParse', () => {
    const result = setupAdministratorRequestSchema.safeParse({
      email: 'admin@example.com',
      password: 'a'.repeat(73),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email format via safeParse', () => {
    const result = setupAdministratorRequestSchema.safeParse({
      email: 'not-an-email',
      password: 'securePassword123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects displayName longer than 100 characters via safeParse', () => {
    const result = setupAdministratorRequestSchema.safeParse({
      email: 'admin@example.com',
      password: 'securePassword123',
      displayName: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

describe('domainNameSchema', () => {
  it('accepts a valid domain', () => {
    const result = domainNameSchema.parse('example.com');
    expect(result).toBe('example.com');
  });

  it('normalises to lowercase + trimmed form (R-DATA-001)', () => {
    const result = domainNameSchema.parse('  EXAMPLE.COM ');
    expect(result).toBe('example.com');
  });

  it('accepts a subdomain', () => {
    const result = domainNameSchema.parse('mail.example.com');
    expect(result).toBe('mail.example.com');
  });

  it('accepts domain with hyphens in labels', () => {
    const result = domainNameSchema.parse('mail-server.example.com');
    expect(result).toBe('mail-server.example.com');
  });

  it('rejects domain without dots via safeParse', () => {
    const result = domainNameSchema.safeParse('example');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects domain starting with hyphen via safeParse', () => {
    const result = domainNameSchema.safeParse('-example.com');
    expect(result.success).toBe(false);
  });

  it('rejects domain ending with hyphen via safeParse', () => {
    const result = domainNameSchema.safeParse('example-.com');
    expect(result.success).toBe(false);
  });

  it('rejects label starting with hyphen via safeParse', () => {
    const result = domainNameSchema.safeParse('mail.-example.com');
    expect(result.success).toBe(false);
  });

  it('rejects label ending with hyphen via safeParse', () => {
    const result = domainNameSchema.safeParse('mail.example-.com');
    expect(result.success).toBe(false);
  });

  it('rejects domain with special characters via safeParse', () => {
    const result = domainNameSchema.safeParse('example_test.com');
    expect(result.success).toBe(false);
  });

  it('rejects domain with spaces via safeParse', () => {
    const result = domainNameSchema.safeParse('example test.com');
    expect(result.success).toBe(false);
  });

  it('rejects domain shorter than 4 chars via safeParse', () => {
    const result = domainNameSchema.safeParse('a.b');
    expect(result.success).toBe(false);
  });

  it('accepts minimum valid domain length (4 chars)', () => {
    const result = domainNameSchema.parse('a.co');
    expect(result).toBe('a.co');
  });

  it('rejects domain longer than 253 chars via safeParse', () => {
    const long = `${'a'.repeat(64)}.${'b'.repeat(64)}.${'c'.repeat(64)}.${'d'.repeat(64)}.com`;
    const result = domainNameSchema.safeParse(long);
    expect(result.success).toBe(false);
  });
});

describe('setupDomainRequestSchema', () => {
  it('accepts a valid domain request', () => {
    const result = setupDomainRequestSchema.parse({
      name: 'example.com',
    });
    expect(result).toEqual({
      name: 'example.com',
    });
  });

  it('accepts a subdomain request', () => {
    const result = setupDomainRequestSchema.parse({
      name: 'mail.example.com',
    });
    expect(result).toEqual({
      name: 'mail.example.com',
    });
  });

  it('normalises domain to lowercase and trimmed (R-DATA-001)', () => {
    const result = setupDomainRequestSchema.parse({
      name: '  EXAMPLE.COM  ',
    });
    expect(result.name).toBe('example.com');
  });

  it('rejects missing name via safeParse', () => {
    const result = setupDomainRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid domain format via safeParse', () => {
    const result = setupDomainRequestSchema.safeParse({
      name: 'not-a-domain',
    });
    expect(result.success).toBe(false);
  });
});

describe('setupBrevoRequestSchema', () => {
  it('accepts a valid API key', () => {
    const result = setupBrevoRequestSchema.parse({
      apiKey: 'xkeysib-abc123def456',
    });
    expect(result).toEqual({
      apiKey: 'xkeysib-abc123def456',
    });
  });

  it('rejects missing apiKey via safeParse', () => {
    const result = setupBrevoRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects empty apiKey via safeParse', () => {
    const result = setupBrevoRequestSchema.safeParse({ apiKey: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects whitespace-only apiKey via safeParse', () => {
    const result = setupBrevoRequestSchema.safeParse({ apiKey: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('permissionKeySchema', () => {
  it('accepts all valid permission keys via parse', () => {
    const keys: Array<ReturnType<typeof permissionKeySchema.parse>> = [
      'message.read',
      'message.send',
      'message.delete',
      'mailbox.create',
      'mailbox.manage',
      'mailbox.share',
      'user.read',
      'user.manage',
      'role.read',
      'role.manage',
      'domain.read',
      'domain.manage',
      'signature.read',
      'signature.manage',
      'settings.read',
      'settings.manage',
      'provider.sync',
      'webhook_event.read',
      'webhook_event.delete',
      'analytics.read',
    ];

    for (const key of keys) {
      const result = permissionKeySchema.parse(key);
      expect(result).toBe(key);
    }
  });

  it('rejects invalid permission keys via safeParse', () => {
    const result = permissionKeySchema.safeParse('invalid.permission');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-string input via safeParse', () => {
    const result = permissionKeySchema.safeParse(123);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects empty string via safeParse', () => {
    const result = permissionKeySchema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('has exactly 20 permission keys', () => {
    // Verify the enum has the expected size
    const allKeys = permissionKeySchema.options;
    expect(allKeys).toHaveLength(20);
    expect(new Set(allKeys).size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// CAP-018: Admin invite codes
// ---------------------------------------------------------------------------

describe('createInviteCodeRequestSchema', () => {
  it('accepts a valid request with all fields via parse', () => {
    const result = createInviteCodeRequestSchema.parse({
      maxUses: 5,
      roleId: 'role-123',
      expiresInHours: 24,
    });
    expect(result).toEqual({
      maxUses: 5,
      roleId: 'role-123',
      expiresInHours: 24,
    });
  });

  it('accepts a minimal request (empty object) and applies defaults via parse', () => {
    const result = createInviteCodeRequestSchema.parse({});
    expect(result).toEqual({
      maxUses: 1,
      roleId: undefined,
      expiresInHours: undefined,
    });
  });

  it('accepts maxUses explicitly via parse', () => {
    const result = createInviteCodeRequestSchema.parse({
      maxUses: 10,
    });
    expect(result).toEqual({
      maxUses: 10,
      roleId: undefined,
      expiresInHours: undefined,
    });
  });

  it('rejects maxUses < 1 via safeParse', () => {
    const result = createInviteCodeRequestSchema.safeParse({ maxUses: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects negative maxUses via safeParse', () => {
    const result = createInviteCodeRequestSchema.safeParse({ maxUses: -5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-integer maxUses via safeParse', () => {
    const result = createInviteCodeRequestSchema.safeParse({ maxUses: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-string roleId via safeParse', () => {
    const result = createInviteCodeRequestSchema.safeParse({ roleId: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects expiresInHours <= 0 via safeParse', () => {
    const result = createInviteCodeRequestSchema.safeParse({ expiresInHours: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects negative expiresInHours via safeParse', () => {
    const result = createInviteCodeRequestSchema.safeParse({ expiresInHours: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-integer expiresInHours via safeParse', () => {
    const result = createInviteCodeRequestSchema.safeParse({ expiresInHours: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('applies default maxUses when only other fields present via parse', () => {
    const result = createInviteCodeRequestSchema.parse({
      roleId: 'role-456',
      expiresInHours: 48,
    });
    expect(result).toEqual({
      maxUses: 1,
      roleId: 'role-456',
      expiresInHours: 48,
    });
  });
});
describe('registerRequestSchema', () => {
  it('accepts a valid registration request', () => {
    const result = registerRequestSchema.parse({
      code: 'a'.repeat(64), // 64-char hex code
      email: 'user@example.com',
      password: 'securePassword123',
    });
    expect(result.email).toBe('user@example.com');
    expect(result.password).toBe('securePassword123');
  });

  it('rejects missing code via safeParse', () => {
    const result = registerRequestSchema.safeParse({
      email: 'user@example.com',
      password: 'securePassword123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing email via safeParse', () => {
    const result = registerRequestSchema.safeParse({
      code: 'a'.repeat(64),
      password: 'securePassword123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email via safeParse', () => {
    const result = registerRequestSchema.safeParse({
      code: 'a'.repeat(64),
      email: 'not-an-email',
      password: 'securePassword123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects code not exactly 64 characters via safeParse', () => {
    const result = registerRequestSchema.safeParse({
      code: 'abc123',
      email: 'user@example.com',
      password: 'securePassword123',
    });
    expect(result.success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('accepts a valid login request', () => {
    const result = loginRequestSchema.parse({
      email: 'user@example.com',
      password: 'securePassword123',
    });
    expect(result.email).toBe('user@example.com');
  });

  it('rejects missing password via safeParse', () => {
    const result = loginRequestSchema.safeParse({
      email: 'user@example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing email via safeParse', () => {
    const result = loginRequestSchema.safeParse({
      password: 'securePassword123',
    });
    expect(result.success).toBe(false);
  });
});

describe('refreshRequestSchema', () => {
  it('accepts a valid refresh request', () => {
    const result = refreshRequestSchema.parse({
      refreshToken: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.refreshToken).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('rejects missing refreshToken via safeParse', () => {
    const result = refreshRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-uuid refreshToken via safeParse', () => {
    const result = refreshRequestSchema.safeParse({ refreshToken: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });
});
