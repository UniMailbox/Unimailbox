import { describe, expect, it } from 'vitest';
import {
  createManagedDomainRequestSchema,
  deleteManagedDomainResponseSchema,
  managedDomainListResponseSchema,
  managedDomainSchema,
  verifyManagedDomainRequestSchema,
  verifyManagedDomainResponseSchema,
} from './domains';

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001';

const domain = {
  id: DOMAIN_ID,
  name: 'example.com',
  status: 'active',
  outboundConnectionId: null,
  createdAt: '2026-08-31 00:00:00',
  updatedAt: '2026-08-31 00:00:00',
};

describe('managed domain contracts (CAP-066)', () => {
  it('normalizes a create request and rejects unknown fields', () => {
    expect(createManagedDomainRequestSchema.parse({ name: '  EXAMPLE.COM ' })).toEqual({
      name: 'example.com',
    });
    expect(
      createManagedDomainRequestSchema.safeParse({ name: 'example.com', outboundConnectionId: 'x' })
        .success,
    ).toBe(false);
  });

  it('accepts only the safe managed-domain projection', () => {
    expect(managedDomainSchema.parse(domain)).toEqual(domain);
    expect(
      managedDomainSchema.safeParse({ ...domain, credential: 'secret-adjacent' }).success,
    ).toBe(false);
    expect(managedDomainListResponseSchema.parse({ items: [domain] })).toEqual({
      items: [domain],
    });
  });

  it('keeps verification and deletion response shapes closed', () => {
    expect(verifyManagedDomainRequestSchema.parse({})).toEqual({});
    expect(verifyManagedDomainRequestSchema.safeParse({ cloudflare: true }).success).toBe(false);
    expect(
      verifyManagedDomainResponseSchema.parse({ verified: true, domain: 'example.com' }),
    ).toEqual({ verified: true, domain: 'example.com' });
    expect(deleteManagedDomainResponseSchema.parse({ id: DOMAIN_ID, deleted: true })).toEqual({
      id: DOMAIN_ID,
      deleted: true,
    });
    expect(
      verifyManagedDomainResponseSchema.safeParse({
        verified: true,
        domain: 'example.com',
        id: DOMAIN_ID,
      }).success,
    ).toBe(false);
  });
});
