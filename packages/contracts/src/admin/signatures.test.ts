import { describe, expect, it } from 'vitest';
import {
  createSignatureRequestSchema,
  signatureListResponseSchema,
  signatureSchema,
  updateSignatureRequestSchema,
} from './signatures';

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001';
const SIGNATURE_ID = '00000000-0000-4000-8000-000000000002';

describe('signature contracts (CAP-068)', () => {
  it('accepts the one-per-domain projection and strict full-replacement inputs', () => {
    const signature = {
      id: SIGNATURE_ID,
      domainId: DOMAIN_ID,
      domainName: 'example.com',
      htmlContent: '<p>Regards</p>',
      textContent: 'Regards',
      isEnabled: true,
      createdAt: '2026-09-01 00:00:00',
      updatedAt: '2026-09-01 00:00:00',
    };

    expect(signatureSchema.parse(signature)).toEqual(signature);
    expect(
      createSignatureRequestSchema.parse({
        domainId: DOMAIN_ID,
        htmlContent: '<p>Regards</p>',
        textContent: 'Regards',
        isEnabled: true,
      }),
    ).toMatchObject({ domainId: DOMAIN_ID, isEnabled: true });
    expect(
      updateSignatureRequestSchema.parse({
        htmlContent: '<p>Regards</p>',
        textContent: 'Regards',
        isEnabled: true,
      }),
    ).toMatchObject({ htmlContent: '<p>Regards</p>' });
    expect(signatureListResponseSchema.parse({ items: [signature] }).items).toHaveLength(1);
  });

  it('rejects unknown fields, invalid ids, and an empty signature', () => {
    expect(
      createSignatureRequestSchema.safeParse({
        domainId: DOMAIN_ID,
        htmlContent: '',
        textContent: '',
        isEnabled: true,
      }).success,
    ).toBe(false);
    expect(
      createSignatureRequestSchema.safeParse({
        domainId: 'not-a-uuid',
        htmlContent: '<p>Regards</p>',
        textContent: 'Regards',
        isEnabled: true,
      }).success,
    ).toBe(false);
    expect(
      updateSignatureRequestSchema.safeParse({
        htmlContent: '<p>Regards</p>',
        textContent: 'Regards',
        isEnabled: true,
        domainId: DOMAIN_ID,
      }).success,
    ).toBe(false);
  });

  it('bounds each content field below the API body limit', () => {
    const oversized = 'x'.repeat(100_001);
    expect(
      createSignatureRequestSchema.safeParse({
        domainId: DOMAIN_ID,
        htmlContent: oversized,
        textContent: 'Regards',
        isEnabled: true,
      }).success,
    ).toBe(false);
    expect(
      updateSignatureRequestSchema.safeParse({
        htmlContent: '<p>Regards</p>',
        textContent: oversized,
        isEnabled: true,
      }).success,
    ).toBe(false);
  });
});
