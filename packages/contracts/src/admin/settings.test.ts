import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYSTEM_SETTINGS,
  systemSettingsResponseSchema,
  updateSystemSettingsRequestSchema,
} from './settings';

const validSettings = { ...DEFAULT_SYSTEM_SETTINGS };

describe('system settings contracts (CAP-069)', () => {
  it('R-SETTINGS-006 accepts the bounded typed settings projection', () => {
    expect(updateSystemSettingsRequestSchema.parse(validSettings)).toEqual(validSettings);
    expect(
      systemSettingsResponseSchema.parse({
        settings: validSettings,
        environment: 'local',
        canManage: true,
        updatedAt: '1970-01-01 00:00:00',
      }).settings,
    ).toEqual(validSettings);
  });

  it('R-SETTINGS-001 R-SETTINGS-006 rejects unknown, secret-shaped, and out-of-range fields', () => {
    expect(
      updateSystemSettingsRequestSchema.safeParse({ ...validSettings, brevoApiKey: 'secret' })
        .success,
    ).toBe(false);
    expect(
      updateSystemSettingsRequestSchema.safeParse({ ...validSettings, subjectBlocklist: [] })
        .success,
    ).toBe(false);
    expect(
      updateSystemSettingsRequestSchema.safeParse({ ...validSettings, maxAttachmentBytes: 0 })
        .success,
    ).toBe(false);
    expect(
      updateSystemSettingsRequestSchema.safeParse({ ...validSettings, maxMailboxesPerUser: 101 })
        .success,
    ).toBe(false);
    expect(
      updateSystemSettingsRequestSchema.safeParse({ ...validSettings, auditRetentionDays: 3651 })
        .success,
    ).toBe(false);
  });

  it('R-SETTINGS-008 keeps environment and manage capability outside the write contract', () => {
    expect(
      updateSystemSettingsRequestSchema.safeParse({
        ...validSettings,
        environment: 'production',
        canManage: true,
      }).success,
    ).toBe(false);
    expect(
      systemSettingsResponseSchema.safeParse({
        settings: validSettings,
        environment: 'production',
        canManage: true,
        updatedAt: '2026-09-01 00:00:00',
        brevoApiKey: 'secret',
      }).success,
    ).toBe(false);
  });
});
