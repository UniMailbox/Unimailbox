import { describe, expect, it } from 'vitest';
import {
  aiBaseUrlSchema,
  aiConfigurationSchema,
  aiGenerateRequestSchema,
  aiReplyRequestSchema,
  aiReplyResponseSchema,
  DEFAULT_AI_CONFIGURATION,
  updateAiConfigurationSchema,
} from './ai';

describe('AI contracts', () => {
  it('bounds composer context and rejects client-supplied source text or routing', () => {
    const input = { subject: 'Hello', language: 'en' };
    expect(aiReplyRequestSchema.parse(input)).toEqual({
      ...input,
      draftBody: '',
      instructions: '',
    });
    for (const extra of [
      { sourceMessageId: 'invalid' },
      { sourceBody: 'private' },
      { baseUrl: 'https://example.test' },
      { instructions: 'x'.repeat(4001) },
      { draftBody: 'x'.repeat(16001) },
    ])
      expect(aiReplyRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(aiReplyResponseSchema.safeParse({ text: 'x'.repeat(16001) }).success).toBe(false);
  });
  it('defaults to disabled and requires a model when enabled', () => {
    expect(aiConfigurationSchema.parse(DEFAULT_AI_CONFIGURATION).enabled).toBe(false);
    expect(
      aiConfigurationSchema.safeParse({ ...DEFAULT_AI_CONFIGURATION, enabled: true }).success,
    ).toBe(false);
  });
  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/?token=x',
    'https://example.com/#x',
    'https://example.com@evil.com',
  ])('rejects unsafe base URL %s', (url) => {
    expect(aiBaseUrlSchema.safeParse(url).success).toBe(false);
  });
  it('accepts a compatible SDK base path and rejects unknown protocols', () => {
    expect(aiBaseUrlSchema.parse('https://ai.example.com/v1')).toBe('https://ai.example.com/v1');
    expect(
      aiConfigurationSchema.safeParse({ ...DEFAULT_AI_CONFIGURATION, protocol: 'other' }).success,
    ).toBe(false);
  });
  it('distinguishes key omission, removal and replacement', () => {
    expect(
      updateAiConfigurationSchema.parse({ configuration: DEFAULT_AI_CONFIGURATION }).apiKey,
    ).toBeUndefined();
    expect(
      updateAiConfigurationSchema.parse({ configuration: DEFAULT_AI_CONFIGURATION, apiKey: null })
        .apiKey,
    ).toBeNull();
    expect(
      updateAiConfigurationSchema.safeParse({ configuration: DEFAULT_AI_CONFIGURATION, apiKey: '' })
        .success,
    ).toBe(false);
  });
  it('rejects foreign fields and native binding base URLs', () => {
    expect(
      aiConfigurationSchema.safeParse({
        ...DEFAULT_AI_CONFIGURATION,
        baseUrl: 'https://example.com',
      }).success,
    ).toBe(false);
    expect(
      updateAiConfigurationSchema.safeParse({
        configuration: DEFAULT_AI_CONFIGURATION,
        credential: 'leak',
      }).success,
    ).toBe(false);
  });
  it('keeps business messages independent of provider SDK formats', () => {
    expect(
      aiGenerateRequestSchema.parse({ messages: [{ role: 'user', content: 'Hi' }] }).output,
    ).toEqual({ type: 'text' });
    expect(
      aiGenerateRequestSchema.safeParse({ messages: [{ role: 'system', content: 'Hi' }] }).success,
    ).toBe(false);
  });
});
