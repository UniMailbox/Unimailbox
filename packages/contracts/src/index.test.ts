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
  createMailboxRequestSchema,
  mailboxListItemSchema,
  mailboxListResponseSchema,
  messageRecipientSchema,
  messageListItemSchema,
  messageListResponseSchema,
  messageDetailSchema,
  messageThreadResponseSchema,
  toggleStarResponseSchema,
  auditActionSchema,
  auditEventSchema,
  auditEventListResponseSchema,
  auditEventQueryParamsSchema,
  composeRecipientSchema,
  composeRequestSchema,
  composeResponseSchema,
  messageStatusSchema,
  outboundJobStatusSchema,
  type MessageStatus,
  type OutboundJobStatus,
  STATUS_RANK_TABLE,
  ALLOWED_MESSAGE_TRANSITIONS,
  ALLOWED_JOB_TRANSITIONS,
  canTransition,
  assertCanTransition,
  allowedFromForMessageStatus,
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
      // D-CAP-044-D (CAP-044 Slice 2): audit reading is a distinct
      // authority from user.read / webhook_event.read.
      'audit.read',
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

  it('has exactly 21 permission keys (D-CAP-044-D adds audit.read)', () => {
    // Verify the enum has the expected size. The enum is closed
    // (R-AUTHZ-001): the count moving means a deliberate change — the
    // seed (modules/admin/seed-repository.ts) and the closure test must
    // move with it.
    const allKeys = permissionKeySchema.options;
    expect(allKeys).toHaveLength(21);
    expect(new Set(allKeys).size).toBe(21);
    expect(allKeys).toContain('audit.read');
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

// ---------------------------------------------------------------------------
// CAP-020: Mailboxes
// ---------------------------------------------------------------------------

describe('createMailboxRequestSchema', () => {
  it('accepts a valid request with displayName', () => {
    const result = createMailboxRequestSchema.parse({
      localPart: 'john.doe',
      domainId: '00000000-0000-4000-8000-000000000001',
      displayName: 'John Doe',
    });
    expect(result).toEqual({
      localPart: 'john.doe',
      domainId: '00000000-0000-4000-8000-000000000001',
      displayName: 'John Doe',
    });
  });

  it('accepts a valid request without displayName', () => {
    const result = createMailboxRequestSchema.parse({
      localPart: 'info',
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result).toEqual({
      localPart: 'info',
      domainId: '00000000-0000-4000-8000-000000000001',
      displayName: undefined,
    });
  });

  it('accepts localPart with dots, hyphens, underscores', () => {
    const result = createMailboxRequestSchema.parse({
      localPart: 'john.doe-test',
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.localPart).toBe('john.doe-test');
  });

  it('accepts localPart with numbers', () => {
    const result = createMailboxRequestSchema.parse({
      localPart: 'user123',
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.localPart).toBe('user123');
  });

  it('rejects missing localPart via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing domainId via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: 'john.doe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty localPart via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: '',
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects localPart longer than 64 chars via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: 'a'.repeat(65),
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects localPart starting with special char via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: '.john',
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects localPart ending with special char via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: 'john.',
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects localPart with invalid special chars via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: 'john@doe',
      domainId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-uuid domainId via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: 'john.doe',
      domainId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects displayName longer than 100 chars via safeParse', () => {
    const result = createMailboxRequestSchema.safeParse({
      localPart: 'john.doe',
      domainId: '00000000-0000-4000-8000-000000000001',
      displayName: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAP-020 mailboxes list response — promoted from the web's local schema in
// CAP-043 Slice 3 (Slice 1 review, arch MEDIUM). The shape is the envelope's
// inner `data` object; the wire body is `{ data: { items: [...] } }`.
// ---------------------------------------------------------------------------

describe('mailboxListItemSchema', () => {
  it('accepts a valid item', () => {
    const result = mailboxListItemSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      address: 'inbox@example.com',
      displayName: 'Inbox',
      status: 'active',
      domainId: '00000000-0000-4000-8000-000000000002',
      localPart: 'inbox',
      ownerUserId: '00000000-0000-4000-8000-000000000003',
    });
    expect(result.address).toBe('inbox@example.com');
    expect(result.localPart).toBe('inbox');
  });

  it('accepts an empty displayName', () => {
    const result = mailboxListItemSchema.parse({
      id: 'mb-1',
      address: 'inbox@example.com',
      displayName: '',
      status: 'active',
      domainId: 'd-1',
      localPart: 'inbox',
      ownerUserId: 'u-1',
    });
    expect(result.displayName).toBe('');
  });

  it('rejects a missing address via safeParse', () => {
    const result = mailboxListItemSchema.safeParse({
      id: 'mb-1',
      displayName: '',
      status: 'active',
      domainId: 'd-1',
      localPart: 'inbox',
      ownerUserId: 'u-1',
    });
    expect(result.success).toBe(false);
  });
});

describe('mailboxListResponseSchema', () => {
  it('accepts a response with two items', () => {
    const result = mailboxListResponseSchema.parse({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          address: 'one@example.com',
          displayName: '',
          status: 'active',
          domainId: 'd-1',
          localPart: 'one',
          ownerUserId: 'u-1',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          address: 'two@example.com',
          displayName: 'Two',
          status: 'active',
          domainId: 'd-1',
          localPart: 'two',
          ownerUserId: 'u-1',
        },
      ],
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[1]?.address).toBe('two@example.com');
  });

  it('accepts an empty list', () => {
    const result = mailboxListResponseSchema.parse({ items: [] });
    expect(result.items).toEqual([]);
  });

  it('rejects a missing items array via safeParse', () => {
    const result = mailboxListResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-array items via safeParse', () => {
    const result = mailboxListResponseSchema.safeParse({ items: 'nope' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAP-022: Message response schemas
// ---------------------------------------------------------------------------

describe('messageRecipientSchema', () => {
  it('accepts a valid recipient', () => {
    const result = messageRecipientSchema.parse({
      address: 'user@example.com',
      displayName: 'User',
    });
    expect(result).toEqual({ address: 'user@example.com', displayName: 'User' });
  });

  it('accepts an empty displayName', () => {
    const result = messageRecipientSchema.parse({
      address: 'user@example.com',
      displayName: '',
    });
    expect(result.displayName).toBe('');
  });

  it('rejects missing address via safeParse', () => {
    const result = messageRecipientSchema.safeParse({ displayName: 'User' });
    expect(result.success).toBe(false);
  });

  it('rejects missing displayName via safeParse', () => {
    const result = messageRecipientSchema.safeParse({ address: 'user@example.com' });
    expect(result.success).toBe(false);
  });
});

describe('messageListItemSchema', () => {
  it('accepts a valid list item with recipients', () => {
    const result = messageListItemSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      fromAddress: 'sender@example.com',
      fromName: 'Sender',
      subject: 'Hello',
      isRead: 0,
      isStarred: 0,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      recipients: {
        to: [{ address: 'recipient@example.com', displayName: 'Recipient' }],
        cc: [],
      },
    });
    expect(result.subject).toBe('Hello');
    expect(result.recipients.to).toHaveLength(1);
  });

  it('accepts an item with isRead = 1', () => {
    const result = messageListItemSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      fromAddress: 'sender@example.com',
      fromName: '',
      subject: '',
      isRead: 1,
      isStarred: 1,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      recipients: { to: [], cc: [] },
    });
    expect(result.isRead).toBe(1);
    expect(result.isStarred).toBe(1);
  });

  it('rejects non-uuid id via safeParse', () => {
    const result = messageListItemSchema.safeParse({
      id: 'not-a-uuid',
      fromAddress: 'sender@example.com',
      fromName: '',
      subject: '',
      isRead: 0,
      isStarred: 0,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      recipients: { to: [], cc: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing recipients via safeParse', () => {
    const result = messageListItemSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      fromAddress: 'sender@example.com',
      fromName: '',
      subject: '',
      isRead: 0,
      isStarred: 0,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('messageListResponseSchema', () => {
  it('accepts a response with items and a null cursor', () => {
    const result = messageListResponseSchema.parse({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          fromAddress: 'sender@example.com',
          fromName: 'Sender',
          subject: 'Hello',
          isRead: 0,
          isStarred: 0,
          folder: 'inbox',
          createdAt: '2026-01-01T00:00:00.000Z',
          recipients: { to: [], cc: [] },
        },
      ],
      nextCursor: null,
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('accepts an empty page', () => {
    const result = messageListResponseSchema.parse({
      items: [],
      nextCursor: null,
    });
    expect(result.items).toEqual([]);
  });

  it('accepts a non-null cursor string', () => {
    const result = messageListResponseSchema.parse({
      items: [],
      nextCursor: 'eyJjcmVhdGVkQXQiOiIyMDI2IiwiaWQiOiJ4In0=',
    });
    expect(result.nextCursor).toBe('eyJjcmVhdGVkQXQiOiIyMDI2IiwiaWQiOiJ4In0=');
  });

  it('rejects a missing nextCursor via safeParse', () => {
    const result = messageListResponseSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });
});

describe('messageDetailSchema', () => {
  it('accepts a valid detail with null messageIdHeader', () => {
    const result = messageDetailSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      fromAddress: 'sender@example.com',
      fromName: 'Sender',
      subject: 'Hello',
      htmlBody: '<p>Hi</p>',
      textBody: 'Hi',
      messageIdHeader: null,
      inReplyToHeader: null,
      referencesHeader: '',
      status: 'delivered',
      isRead: 0,
      isStarred: 0,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      recipients: {
        to: [{ address: 'recipient@example.com', displayName: 'Recipient' }],
        cc: [],
      },
    });
    expect(result.messageIdHeader).toBeNull();
    expect(result.inReplyToHeader).toBeNull();
    expect(result.htmlBody).toBe('<p>Hi</p>');
  });

  it('accepts non-null header values', () => {
    const result = messageDetailSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      fromAddress: 'sender@example.com',
      fromName: 'Sender',
      subject: 'Re: Hello',
      htmlBody: '<p>Hi</p>',
      textBody: 'Hi',
      messageIdHeader: '<abc@example.com>',
      inReplyToHeader: '<def@example.com>',
      referencesHeader: '<def@example.com>',
      status: 'delivered',
      isRead: 1,
      isStarred: 0,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      recipients: { to: [], cc: [] },
    });
    expect(result.messageIdHeader).toBe('<abc@example.com>');
    expect(result.inReplyToHeader).toBe('<def@example.com>');
  });

  it('rejects missing htmlBody via safeParse', () => {
    const result = messageDetailSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      fromAddress: 'sender@example.com',
      fromName: '',
      subject: '',
      textBody: '',
      messageIdHeader: null,
      inReplyToHeader: null,
      referencesHeader: '',
      status: 'delivered',
      isRead: 0,
      isStarred: 0,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      recipients: { to: [], cc: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-string status via safeParse', () => {
    const result = messageDetailSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      fromAddress: 'sender@example.com',
      fromName: '',
      subject: '',
      htmlBody: '',
      textBody: '',
      messageIdHeader: null,
      inReplyToHeader: null,
      referencesHeader: '',
      status: 123,
      isRead: 0,
      isStarred: 0,
      folder: 'inbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      recipients: { to: [], cc: [] },
    });
    expect(result.success).toBe(false);
  });
});

// CAP-043 (AC 10): the thread response wraps the list-item shape with the
// resolved thread root. `rootId` is nullable — a message with no threading
// headers at all is its own singleton thread and resolves to null
// (D-CAP-043-C).
describe('messageThreadResponseSchema', () => {
  it('accepts a response with a rootId and items', () => {
    const result = messageThreadResponseSchema.parse({
      rootId: '<root@example.com>',
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          fromAddress: 'sender@example.com',
          fromName: 'Sender',
          subject: 'Hello',
          isRead: 0,
          isStarred: 0,
          folder: 'inbox',
          createdAt: '2026-01-01T00:00:00.000Z',
          recipients: { to: [], cc: [] },
        },
      ],
    });
    expect(result.rootId).toBe('<root@example.com>');
    expect(result.items).toHaveLength(1);
  });

  it('accepts a null rootId for a singleton thread', () => {
    const result = messageThreadResponseSchema.parse({
      rootId: null,
      items: [],
    });
    expect(result.rootId).toBeNull();
    expect(result.items).toEqual([]);
  });

  it('rejects a missing rootId via safeParse', () => {
    const result = messageThreadResponseSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });
});

// CAP-043 Slice 3 (AC 14): the star toggle response covers the full wire
// body `{ data: { id, isStarred } }`. isStarred is the SQLite 0/1 integer,
// same convention as messageListItemSchema (D-CAP-043-A: mailbox-level).
describe('toggleStarResponseSchema', () => {
  it('accepts a starred response', () => {
    const result = toggleStarResponseSchema.parse({
      data: { id: '00000000-0000-4000-8000-000000000001', isStarred: 1 },
    });
    expect(result.data.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(result.data.isStarred).toBe(1);
  });

  it('accepts an unstarred response', () => {
    const result = toggleStarResponseSchema.parse({
      data: { id: '00000000-0000-4000-8000-000000000001', isStarred: 0 },
    });
    expect(result.data.isStarred).toBe(0);
  });

  it('rejects a non-uuid id via safeParse', () => {
    const result = toggleStarResponseSchema.safeParse({
      data: { id: 'not-a-uuid', isStarred: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing data envelope via safeParse', () => {
    const result = toggleStarResponseSchema.safeParse({ id: '00000000-0000-4000-8000-000000000001' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing isStarred via safeParse', () => {
    const result = toggleStarResponseSchema.safeParse({
      data: { id: '00000000-0000-4000-8000-000000000001' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-number isStarred via safeParse', () => {
    const result = toggleStarResponseSchema.safeParse({
      data: { id: '00000000-0000-4000-8000-000000000001', isStarred: true },
    });
    expect(result.success).toBe(false);
  });
});

// CAP-043 Slice 3 fix H4 / D-CAP-043-I: the closed audit-action enum gains
// `message.star_toggled` and `message.soft_deleted`. The enum is closed by
// design — a value reaching audit_events that is not in this list is a
// contract violation, so coverage pins the exact option set.
describe('auditActionSchema — closed enum (D-CAP-043-I)', () => {
  it('contains the exact expected option set, including the CAP-043 message actions', () => {
    expect([...auditActionSchema.options].sort()).toEqual(
      [
        'setup.claim',
        'setup.complete',
        'mailbox.create',
        'message.receive',
        'message.send',
        'webhook.delivered',
        'blocklist.create',
        'blocklist.delete',
        'role_policy.set',
        'webhook_delivery.reconcile',
        'webhook_secret.reveal',
        'message.star_toggled',
        'message.soft_deleted',
      ].sort(),
    );
  });

  it('accepts every declared action (parse round-trip)', () => {
    for (const action of auditActionSchema.options) {
      expect(auditActionSchema.parse(action)).toBe(action);
    }
  });

  it('accepts message.star_toggled and message.soft_deleted (the H4 additions)', () => {
    expect(auditActionSchema.parse('message.star_toggled')).toBe('message.star_toggled');
    expect(auditActionSchema.parse('message.soft_deleted')).toBe('message.soft_deleted');
  });

  it('rejects an undeclared action (the enum is closed)', () => {
    const result = auditActionSchema.safeParse('message.hard_deleted');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAP-044 Slice 2 (AC 12; CAP-033 absorbed, D-CAP-044-E): the audit-event
// read-side schemas — one response row, the list envelope, and the
// query-params contract for GET /api/v1/admin/audit-events.
// ---------------------------------------------------------------------------

describe('auditEventSchema — response row (CAP-044 Slice 2)', () => {
  const FULL_ROW = {
    id: '00000000-0000-4000-8000-000000000001',
    actorUserId: '00000000-0000-4000-8000-000000000002',
    action: 'message.send',
    resourceType: 'message',
    resourceId: '00000000-0000-4000-8000-000000000003',
    requestId: 'req-1',
    metadata: '{"connectionId":"c-1"}',
    ip: '203.0.113.7',
    createdAt: '2026-01-01 00:00:00',
  };

  it('accepts a fully populated row', () => {
    const result = auditEventSchema.parse(FULL_ROW);
    expect(result).toEqual(FULL_ROW);
  });

  it('accepts the null-bearing shape — actor/resource/request/metadata/ip are nullable', () => {
    // R-AUDIT-003/004: system-emitted rows (e.g. message.receive) carry a
    // null actor; metadata/request_id/ip are optional at every emit point.
    // The stored metadata text is OPAQUE — never re-shaped by the schema.
    const result = auditEventSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      actorUserId: null,
      action: 'message.receive',
      resourceType: 'message',
      resourceId: null,
      requestId: null,
      metadata: null,
      ip: null,
      createdAt: '2026-01-01 00:00:00',
    });
    expect(result.actorUserId).toBeNull();
    expect(result.metadata).toBeNull();
  });

  it('rejects a row whose action is outside the closed audit-action enum', () => {
    const result = auditEventSchema.safeParse({ ...FULL_ROW, action: 'message.hard_deleted' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    const result = auditEventSchema.safeParse({ ...FULL_ROW, id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });
});

describe('auditEventListResponseSchema — cursor envelope (R-API-004/005)', () => {
  it('accepts a page with items and a next cursor', () => {
    const result = auditEventListResponseSchema.parse({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          actorUserId: null,
          action: 'setup.claim',
          resourceType: 'system',
          resourceId: null,
          requestId: null,
          metadata: null,
          ip: null,
          createdAt: '2026-01-01 00:00:00',
        },
      ],
      nextCursor: 'opaque-hmac-token',
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('opaque-hmac-token');
  });

  it('accepts the empty end-of-chain page — items: [], nextCursor: null', () => {
    const result = auditEventListResponseSchema.parse({ items: [], nextCursor: null });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('rejects a missing nextCursor (the field is required, nullable)', () => {
    const result = auditEventListResponseSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });
});

describe('auditEventQueryParamsSchema — query contract (CAP-044 Slice 2)', () => {
  const ACTOR = '00000000-0000-4000-8000-00000000000a';

  it('accepts the bare query (no filters)', () => {
    const result = auditEventQueryParamsSchema.parse({});
    expect(result).toEqual({});
  });

  it('accepts each filter on its own', () => {
    expect(auditEventQueryParamsSchema.parse({ actorUserId: ACTOR })).toEqual({
      actorUserId: ACTOR,
    });
    expect(
      auditEventQueryParamsSchema.parse({ resourceType: 'message', resourceId: 'm-1' }),
    ).toEqual({ resourceType: 'message', resourceId: 'm-1' });
    expect(auditEventQueryParamsSchema.parse({ action: 'message.send' })).toEqual({
      action: 'message.send',
    });
  });

  it('accepts every filter composed', () => {
    const input = {
      actorUserId: ACTOR,
      resourceType: 'mailbox',
      resourceId: 'mb-1',
      action: 'mailbox.create',
      cursor: 'opaque-token',
      limit: '25',
    };
    const result = auditEventQueryParamsSchema.parse(input);
    expect(result.actorUserId).toBe(ACTOR);
    expect(result.action).toBe('mailbox.create');
    expect(result.cursor).toBe('opaque-token');
    // limit arrives as a query STRING and coerces to a number.
    expect(result.limit).toBe(25);
  });

  it('rejects resourceType without resourceId (the pair rule)', () => {
    const result = auditEventQueryParamsSchema.safeParse({ resourceType: 'message' });
    expect(result.success).toBe(false);
  });

  it('rejects resourceId without resourceType (the pair rule)', () => {
    const result = auditEventQueryParamsSchema.safeParse({ resourceId: 'm-1' });
    expect(result.success).toBe(false);
  });

  it('rejects an action outside the closed audit-action enum', () => {
    const result = auditEventQueryParamsSchema.safeParse({ action: 'not.an.action' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid actorUserId', () => {
    const result = auditEventQueryParamsSchema.safeParse({ actorUserId: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric or non-positive limit', () => {
    expect(auditEventQueryParamsSchema.safeParse({ limit: 'abc' }).success).toBe(false);
    expect(auditEventQueryParamsSchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(auditEventQueryParamsSchema.safeParse({ limit: '-5' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAP-023: Compose request schemas
// ---------------------------------------------------------------------------

describe('composeRecipientSchema', () => {
  it('accepts a valid recipient with address only', () => {
    const result = composeRecipientSchema.parse({ address: 'user@example.com' });
    expect(result).toEqual({ address: 'user@example.com', displayName: undefined });
  });

  it('accepts a valid recipient with displayName', () => {
    const result = composeRecipientSchema.parse({
      address: 'user@example.com',
      displayName: 'User',
    });
    expect(result).toEqual({ address: 'user@example.com', displayName: 'User' });
  });

  it('normalises the email to lowercase (R-DATA-001)', () => {
    const result = composeRecipientSchema.parse({ address: 'USER@Example.COM' });
    expect(result.address).toBe('user@example.com');
  });

  it('rejects missing address via safeParse', () => {
    const result = composeRecipientSchema.safeParse({ displayName: 'User' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email via safeParse', () => {
    const result = composeRecipientSchema.safeParse({ address: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects displayName longer than 100 chars via safeParse', () => {
    const result = composeRecipientSchema.safeParse({
      address: 'user@example.com',
      displayName: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

describe('composeRequestSchema', () => {
  it('accepts a minimal valid request (to only)', () => {
    const result = composeRequestSchema.parse({
      to: [{ address: 'recipient@example.com' }],
    });
    expect(result.to).toEqual([{ address: 'recipient@example.com', displayName: undefined }]);
    expect(result.cc).toEqual([]);
    expect(result.subject).toBe('');
    expect(result.htmlBody).toBe('');
    expect(result.textBody).toBe('');
  });

  it('accepts a full request with all fields', () => {
    const result = composeRequestSchema.parse({
      to: [{ address: 'to@example.com', displayName: 'To' }],
      cc: [{ address: 'cc@example.com' }],
      subject: 'Hello',
      htmlBody: '<p>hi</p>',
      textBody: 'hi',
      inReplyTo: '<prev@example.com>',
      references: '<thread@example.com>',
    });
    expect(result.to).toHaveLength(1);
    expect(result.cc).toHaveLength(1);
    expect(result.subject).toBe('Hello');
    expect(result.htmlBody).toBe('<p>hi</p>');
    expect(result.inReplyTo).toBe('<prev@example.com>');
  });

  it('applies defaults for omitted optional fields', () => {
    const result = composeRequestSchema.parse({
      to: [{ address: 'recipient@example.com' }],
    });
    expect(result.cc).toEqual([]);
    expect(result.subject).toBe('');
    expect(result.htmlBody).toBe('');
    expect(result.textBody).toBe('');
    expect(result.inReplyTo).toBeUndefined();
    expect(result.references).toBeUndefined();
  });

  it('rejects an empty to array via safeParse', () => {
    const result = composeRequestSchema.safeParse({ to: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects a missing to array via safeParse', () => {
    const result = composeRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a to entry with an invalid email via safeParse', () => {
    const result = composeRequestSchema.safeParse({ to: [{ address: 'not-an-email' }] });
    expect(result.success).toBe(false);
  });

  it('rejects a subject longer than 998 chars via safeParse', () => {
    const result = composeRequestSchema.safeParse({
      to: [{ address: 'recipient@example.com' }],
      subject: 'a'.repeat(999),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a body over 1MB via safeParse', () => {
    const result = composeRequestSchema.safeParse({
      to: [{ address: 'recipient@example.com' }],
      htmlBody: 'a'.repeat(1_000_001),
    });
    expect(result.success).toBe(false);
  });
});

// CAP-044 Slice 1 / AC 3: the send route's 202 body, promoted verbatim
// from the handler (compose.ts stores and replays this exact JSON).
describe('composeResponseSchema', () => {
  it('accepts the 202 body the route produces', () => {
    const result = composeResponseSchema.parse({
      data: { messageId: '00000000-0000-4000-8000-000000000001', status: 'queued' },
    });
    expect(result.data.messageId).toBe('00000000-0000-4000-8000-000000000001');
    expect(result.data.status).toBe('queued');
  });

  it('rejects a missing data object via safeParse', () => {
    const result = composeResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a missing messageId via safeParse', () => {
    const result = composeResponseSchema.safeParse({ data: { status: 'queued' } });
    expect(result.success).toBe(false);
  });

  it('rejects a status other than the queued literal via safeParse', () => {
    const result = composeResponseSchema.safeParse({
      data: { messageId: '00000000-0000-4000-8000-000000000001', status: 'sent' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid messageId via safeParse', () => {
    const result = composeResponseSchema.safeParse({
      data: { messageId: 'not-a-uuid', status: 'queued' },
    });
    expect(result.success).toBe(false);
  });
});

describe('messageStatusSchema — R-MESSAGE-007 closed enum', () => {
  it('accepts every documented message status', () => {
    for (const s of [
      'draft',
      'queued',
      'sending',
      'sent',
      'delivered',
      'delayed',
      'bounced',
      'complained',
      'failed',
    ] as const) {
      expect(messageStatusSchema.parse(s)).toBe(s);
    }
  });

  it('rejects any value outside the closed enum', () => {
    for (const s of ['read', 'opened', 'clicked', '', 'DELIVERED', 'sent ']) {
      const result = messageStatusSchema.safeParse(s);
      expect(result.success).toBe(false);
    }
  });

  // CAP-029 Code L1 review-triage: zod never accepts these at runtime, but
  // a future maintainer tightening the schema should keep the rejections.
  it('rejects null', () => {
    expect(messageStatusSchema.safeParse(null).success).toBe(false);
  });
  it('rejects undefined', () => {
    expect(messageStatusSchema.safeParse(undefined).success).toBe(false);
  });
  it('rejects 0', () => {
    expect(messageStatusSchema.safeParse(0).success).toBe(false);
  });
  it('rejects a positive integer', () => {
    expect(messageStatusSchema.safeParse(42).success).toBe(false);
  });
  it('rejects an empty object', () => {
    expect(messageStatusSchema.safeParse({}).success).toBe(false);
  });
});

describe('STATUS_RANK_TABLE — R-MESSAGE-007 rank guard (CAP-029 Arch M1 / Security M3)', () => {
  // CAP-029 Arch M1 / Security M3 review-triage: STATUS_RANK_TABLE (the
  // contracts-side closed enum) MUST stay in sync with the SQL CASE in
  // apps/worker/src/modules/messages/message-repository.ts (the rank-aware
  // UPDATE predicate). A drift here is a silent ordering bug — the contracts
  // side would say one rank order, the SQL would apply another. This test
  // pins both sides to the same set of {status, rank} pairs without importing
  // the SQL fragment (which would couple this package to worker-only types).
  //
  // When you add a status: also add it here. When you change a rank: also
  // change it in the SQL CASE.
  const EXPECTED_PAIRS: ReadonlyArray<readonly [string, number]> = [
    ['failed', 100],
    ['bounced', 100],
    ['complained', 100],
    ['delivered', 80],
    ['delayed', 60],
    ['queued', 40],
    ['sending', 30],
    ['sent', 20],
    ['draft', 10],
  ];

  it('every status in messageStatusSchema appears in STATUS_RANK_TABLE', () => {
    const ranked = new Set(STATUS_RANK_TABLE.map(([status]) => status));
    for (const s of messageStatusSchema.options) {
      expect(ranked.has(s)).toBe(true);
    }
  });

  it('the ranks match the documented ordering exactly', () => {
    expect(STATUS_RANK_TABLE).toEqual(EXPECTED_PAIRS);
  });

  it('higher-rank numbers correspond to terminal-ness first, then recency-of-life', () => {
    // Terminal failures all share the top rank (100), not just one terminal value.
    const terminalRanks = STATUS_RANK_TABLE.filter(
      ([s]) => s === 'failed' || s === 'bounced' || s === 'complained',
    ).map(([, rank]) => rank);
    expect(terminalRanks).toHaveLength(3);
    expect(new Set(terminalRanks).size).toBe(1);
    expect(terminalRanks[0]).toBe(100);
  });
});

describe('ALLOWED_*_TRANSITIONS — CAP-030 direction guard', () => {
  // CAP-030 D-CAP-030-D: the direction tables are the *policy*; the SQL
  // predicate in `updateMessageStatus` and the hard-coded `status = '...'`
  // predicates in the lease-aware writers are the *enforcement*. A drift
  // here would silently widen (or narrow) the lifecycle without an SQL
  // change to match. Pin both maps to literal expected sets — the worker
  // tests verify the enforcement side.
  //
  // When you add a status: add it here, add it to ALLOWED_*_TRANSITIONS,
  // and update the SQL CASE / WHERE clauses that depend on it. The two
  // pins (this one and the worker-pool direction tests) catch drift in
  // either direction.

  const EXPECTED_MESSAGE_TRANSITIONS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ['draft', ['queued', 'sent']],
    ['queued', ['sending', 'sent', 'delayed', 'failed', 'bounced', 'complained']],
    ['sending', ['sent', 'delayed', 'failed', 'bounced', 'complained']],
    ['sent', ['delivered', 'delayed', 'failed', 'bounced', 'complained']],
    ['delivered', ['failed', 'bounced', 'complained']],
    ['delayed', ['sent', 'delivered', 'failed', 'bounced', 'complained']],
    ['bounced', []],
    ['complained', []],
    ['failed', []],
  ];

  const EXPECTED_JOB_TRANSITIONS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ['queued', ['sending']],
    ['sending', ['sent', 'queued', 'failed']],
    ['sent', []],
    ['delayed', []],
    ['bounced', []],
    ['complained', []],
    ['failed', []],
  ];

  function mapToPairs<K, V>(
    map: ReadonlyMap<K, ReadonlySet<V>>,
  ): ReadonlyArray<readonly [K, ReadonlyArray<V>]> {
    return [...map.entries()].map(([k, v]) => [k, [...v]] as const);
  }

  it('every status in messageStatusSchema appears in ALLOWED_MESSAGE_TRANSITIONS', () => {
    for (const s of messageStatusSchema.options) {
      expect(ALLOWED_MESSAGE_TRANSITIONS.has(s)).toBe(true);
    }
  });

  it('every status in outboundJobStatusSchema appears in ALLOWED_JOB_TRANSITIONS', () => {
    for (const s of outboundJobStatusSchema.options) {
      expect(ALLOWED_JOB_TRANSITIONS.has(s)).toBe(true);
    }
  });

  it('ALLOWED_MESSAGE_TRANSITIONS matches the documented policy exactly', () => {
    expect(mapToPairs(ALLOWED_MESSAGE_TRANSITIONS)).toEqual(EXPECTED_MESSAGE_TRANSITIONS);
  });

  it('ALLOWED_JOB_TRANSITIONS matches the documented policy exactly', () => {
    expect(mapToPairs(ALLOWED_JOB_TRANSITIONS)).toEqual(EXPECTED_JOB_TRANSITIONS);
  });

  it('terminal states have empty allowed-from set on both maps (R-MESSAGE-012 / R-OUTBOUND-009)', () => {
    for (const terminal of ['failed', 'bounced', 'complained'] as const) {
      const messageFrom = ALLOWED_MESSAGE_TRANSITIONS.get(terminal);
      expect(messageFrom, `ALLOWED_MESSAGE_TRANSITIONS missing ${terminal}`).toBeDefined();
      expect([...(messageFrom as ReadonlySet<MessageStatus>)]).toEqual([]);
      const jobFrom = ALLOWED_JOB_TRANSITIONS.get(terminal as OutboundJobStatus);
      expect(jobFrom, `ALLOWED_JOB_TRANSITIONS missing ${terminal}`).toBeDefined();
      expect([...(jobFrom as ReadonlySet<OutboundJobStatus>)]).toEqual([]);
    }
  });

  describe('canTransition — allowed transitions (forward path + legal branches)', () => {
    // Forward path: draft → queued → sending → sent → delivered.
    // Plus the documented legal branches (delayed recovery, terminal
    // promotion, D-CAP-030-F sent → delayed).
    const ALLOWED_MESSAGES: ReadonlyArray<readonly [MessageStatus, MessageStatus]> = [
      ['draft', 'queued'],
      ['draft', 'sent'],
      ['queued', 'sending'],
      ['queued', 'sent'],
      ['queued', 'delayed'],
      ['queued', 'failed'],
      ['queued', 'bounced'],
      ['queued', 'complained'],
      ['sending', 'sent'],
      ['sending', 'delayed'],
      ['sending', 'failed'],
      ['sending', 'bounced'],
      ['sending', 'complained'],
      ['sent', 'delivered'],
      ['sent', 'delayed'], // D-CAP-030-F
      ['sent', 'failed'],
      ['sent', 'bounced'],
      ['sent', 'complained'],
      ['delivered', 'failed'],
      ['delivered', 'bounced'],
      ['delivered', 'complained'],
      ['delayed', 'sent'],
      ['delayed', 'delivered'],
      ['delayed', 'failed'],
      ['delayed', 'bounced'],
      ['delayed', 'complained'],
    ];
    for (const [from, to] of ALLOWED_MESSAGES) {
      it(`messages: ${from} → ${to}`, () => {
        expect(canTransition('message', from, to)).toBe(true);
      });
    }

    const ALLOWED_JOBS: ReadonlyArray<readonly [OutboundJobStatus, OutboundJobStatus]> = [
      ['queued', 'sending'],
      // R-OUTBOUND-008 retry reset (D-CAP-030-B).
      ['sending', 'queued'],
      ['sending', 'sent'],
      ['sending', 'failed'],
    ];
    for (const [from, to] of ALLOWED_JOBS) {
      it(`jobs: ${from} → ${to}`, () => {
        expect(canTransition('job', from, to)).toBe(true);
      });
    }
  });

  describe('canTransition — forbidden transitions (regressions in non-terminal states)', () => {
    // A regression is a `from` with a higher rank than `to` (the rank
    // guard would accept), but a direction violation (the policy
    // disallows it). These are the cases CAP-030 closes.
    const FORBIDDEN_MESSAGES: ReadonlyArray<readonly [MessageStatus, MessageStatus]> = [
      // sent (rank 20) → queued (rank 40) — rank guard would accept on
      // equal time + lower rank. Direction guard rejects (AC #8).
      ['sent', 'queued'],
      // sent → draft — both ranks below 20; direction guard rejects.
      ['sent', 'draft'],
      // queued → draft — no forward path.
      ['queued', 'draft'],
      // queued → sending → sent forward path; queued → sent is allowed
      // (covered above); queued → delivered would skip the send step.
      ['queued', 'delivered'],
      // delivered → sent — terminal correction, not a regression. Even
      // though sent < delivered in rank, the direction table blocks it.
      ['delivered', 'sent'],
      // delayed → queued — rank guard would accept; direction rejects.
      ['delayed', 'queued'],
      // delayed → draft — no path.
      ['delayed', 'draft'],
      // draft → anything other than queued or sent (R-MESSAGE-010).
      ['draft', 'sending'],
      ['draft', 'delivered'],
      ['draft', 'failed'],
      ['draft', 'bounced'],
      ['draft', 'delayed'],
      ['draft', 'complained'],
    ];
    for (const [from, to] of FORBIDDEN_MESSAGES) {
      it(`messages: ${from} → ${to}`, () => {
        expect(canTransition('message', from, to)).toBe(false);
      });
    }
  });

  describe('canTransition — forbidden transitions out of terminal states', () => {
    // R-MESSAGE-012 / R-OUTBOUND-009: terminal is terminal. The empty
    // allowed-from set makes resurrection a closed invariant — even
    // on a strictly-newer event time.
    const TERMINAL_MESSAGES: ReadonlyArray<MessageStatus> = ['failed', 'bounced', 'complained'];
    const ALL_TARGETS_MESSAGES: ReadonlyArray<MessageStatus> = [
      'draft',
      'queued',
      'sending',
      'sent',
      'delivered',
      'delayed',
    ];
    for (const from of TERMINAL_MESSAGES) {
      for (const to of ALL_TARGETS_MESSAGES) {
        it(`messages: ${from} → ${to}`, () => {
          expect(canTransition('message', from, to)).toBe(false);
        });
      }
    }

    const TERMINAL_JOBS: ReadonlyArray<OutboundJobStatus> = [
      'failed',
      'bounced',
      'complained',
      'sent',
    ];
    const ALL_TARGETS_JOBS: ReadonlyArray<OutboundJobStatus> = [
      'queued',
      'sending',
      'sent',
      'delayed',
      'failed',
      'bounced',
      'complained',
    ];
    for (const from of TERMINAL_JOBS) {
      for (const to of ALL_TARGETS_JOBS) {
        // Skip self (e.g. sent → sent) — not in the table, returns false,
        // but the test reads cleaner if we omit it.
        if (from === to) continue;
        it(`jobs: ${from} → ${to}`, () => {
          expect(canTransition('job', from, to)).toBe(false);
        });
      }
    }
  });

  describe('canTransition — forbidden transitions on jobs', () => {
    const FORBIDDEN_JOBS: ReadonlyArray<readonly [OutboundJobStatus, OutboundJobStatus]> = [
      // sent is terminal (R-OUTBOUND-009).
      ['sent', 'queued'],
      ['sent', 'sending'],
      ['sent', 'failed'],
      ['sent', 'bounced'],
      ['sent', 'complained'],
      // delayed has no path forward or back today (D-CAP-030-C).
      ['delayed', 'queued'],
      ['delayed', 'sending'],
      ['delayed', 'sent'],
      ['delayed', 'failed'],
      // queued can only advance to sending.
      ['queued', 'sent'],
      ['queued', 'failed'],
      ['queued', 'bounced'],
      ['queued', 'complained'],
    ];
    for (const [from, to] of FORBIDDEN_JOBS) {
      it(`jobs: ${from} → ${to}`, () => {
        expect(canTransition('job', from, to)).toBe(false);
      });
    }
  });

  describe('canTransition — domain discriminator is load-bearing', () => {
    // The two domains share many status values but have different
    // direction policies. CAP-030 D-CAP-030-B: `sending → queued` is
    // allowed for jobs (R-OUTBOUND-008 retry reset) but forbidden for
    // messages (no forward path). Without the domain argument, the
    // caller could not express this difference.
    it('sending → queued: jobs allow, messages forbid', () => {
      expect(canTransition('job', 'sending', 'queued')).toBe(true);
      expect(canTransition('message', 'sending', 'queued')).toBe(false);
    });

    it('sent → queued: messages forbid (regression), jobs forbid (terminal)', () => {
      expect(canTransition('message', 'sent', 'queued')).toBe(false);
      expect(canTransition('job', 'sent', 'queued')).toBe(false);
    });

    it('failed → sent: both domains forbid (terminal)', () => {
      expect(canTransition('message', 'failed', 'sent')).toBe(false);
      expect(canTransition('job', 'failed', 'sent')).toBe(false);
    });

    it('draft is unreachable in the job domain (no entry in jobs map)', () => {
      // 'draft' is not a key in ALLOWED_JOB_TRANSITIONS, so the .get()
      // returns undefined and the helper short-circuits to false.
      // D-CAP-030-A: 'draft' is a MessageStatus-only value; the test
      // casts it to OutboundJobStatus to assert the runtime guard rather
      // than the compile-time rejection that the new overloads enforce.
      expect(canTransition('job', 'draft' as OutboundJobStatus, 'sent')).toBe(false);
      expect(canTransition('job', 'queued', 'draft' as OutboundJobStatus)).toBe(false);
    });

    it('delivered is unreachable in the job domain', () => {
      // D-CAP-030-A: 'delivered' is messages-only; cast documents the
      // intent (the runtime result is what matters in this test).
      expect(canTransition('job', 'sent', 'delivered' as OutboundJobStatus)).toBe(false);
    });
  });

  describe('assertCanTransition', () => {
    it('does not throw when the transition is allowed (messages)', () => {
      expect(() => assertCanTransition('message', 'queued', 'sending')).not.toThrow();
    });

    it('does not throw when the transition is allowed (jobs, retry reset)', () => {
      expect(() => assertCanTransition('job', 'sending', 'queued')).not.toThrow();
    });

    it('throws plain Error with `domain`, `from`, `to` in the message (D-CAP-030-G)', () => {
      expect(() => assertCanTransition('message', 'sent', 'queued')).toThrowError(
        /assertCanTransition\(message\): sent → queued is not an allowed lifecycle transition/,
      );
    });

    it('forbidden messages-side transition: failed → sent (terminal)', () => {
      expect(() => assertCanTransition('message', 'failed', 'sent')).toThrowError(
        /assertCanTransition\(message\): failed → sent/,
      );
    });

    it('forbidden jobs-side transition: queued → sent (only `sending` is allowed)', () => {
      expect(() => assertCanTransition('job', 'queued', 'sent')).toThrowError(
        /assertCanTransition\(job\): queued → sent/,
      );
    });

    it('messages-side vs jobs-side: same (from, to), different verdict, different error', () => {
      // sending → queued is allowed in jobs, forbidden in messages.
      // The error message must carry the domain so the caller sees the
      // disambiguation context.
      expect(() => assertCanTransition('message', 'sending', 'queued')).toThrowError(
        /\(message\): sending → queued/,
      );
    });
  });

  describe('allowedFromForMessageStatus — SQL IN-clause input', () => {
    it('returns the FROM-set for queued (target reachable only from draft)', () => {
      // Inverse of the message direction table for `to = 'queued'`.
      expect([...allowedFromForMessageStatus('queued')]).toEqual(['draft']);
    });

    it('returns the FROM-set for sent (reachable from draft, queued, sending, delayed)', () => {
      // Insertion order: draft, queued, sending, sent, delivered, delayed,
      // bounced, complained, failed. Skipping non-FROM entries, the
      // match order is: draft, queued, sending, delayed.
      expect([...allowedFromForMessageStatus('sent')]).toEqual([
        'draft',
        'queued',
        'sending',
        'delayed',
      ]);
    });

    it('returns the FROM-set for delivered (reachable from sent, delayed)', () => {
      expect([...allowedFromForMessageStatus('delivered')]).toEqual(['sent', 'delayed']);
    });

    it('returns the FROM-set for the terminal targets — every non-terminal state can fail', () => {
      // Failed/bounced/complained are reachable from every non-terminal
      // status (R-MESSAGE-006: "or terminal"). The inverse function
      // surfaces those sources for the SQL IN-clause.
      expect([...allowedFromForMessageStatus('failed')]).toEqual([
        'queued',
        'sending',
        'sent',
        'delivered',
        'delayed',
      ]);
      expect([...allowedFromForMessageStatus('bounced')]).toEqual([
        'queued',
        'sending',
        'sent',
        'delivered',
        'delayed',
      ]);
      expect([...allowedFromForMessageStatus('complained')]).toEqual([
        'queued',
        'sending',
        'sent',
        'delivered',
        'delayed',
      ]);
    });

    it('returns empty array for `draft` — no FROM state can transition into it', () => {
      // The only writer that produces `draft` is INSERT (bypasses the
      // direction guard, see compose.ts comment). No FROM-state is
      // permitted, so the SQL IN-clause yields an empty row set, and
      // any UPDATE targeting `draft` is rejected.
      expect([...allowedFromForMessageStatus('draft')]).toEqual([]);
    });
  });
});
