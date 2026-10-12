import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_CONFIGURATION,
  type AiAdapter,
  type AiGenerateRequest,
} from '@unimailbox/contracts';
import { createAiService } from './index';

const request: AiGenerateRequest = {
  messages: [{ role: 'user', content: 'Hi' }],
  output: { type: 'text' },
};
function service(generate: AiAdapter<AbortSignal>['generate'], enabled = true) {
  return createAiService({
    loadConfiguration: async () => ({
      configuration: {
        ...DEFAULT_AI_CONFIGURATION,
        enabled,
        model: '@cf/test/model',
        timeoutMs: 1000,
      },
      apiKey: null,
    }),
    adapters: { 'workers-ai': { generate }, openai: { generate }, anthropic: { generate } },
  });
}
afterEach(() => vi.useRealTimers());
describe('AI service', () => {
  it('does not call an adapter when disabled', async () => {
    const generate = vi.fn();
    await expect(service(generate, false).generate(request)).rejects.toMatchObject({
      code: 'AI_DISABLED',
    });
    expect(generate).not.toHaveBeenCalled();
  });
  it('bounds latency even when the native binding never resolves', async () => {
    vi.useFakeTimers();
    const promise = service(() => new Promise(() => {})).generate(request);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
  it('cancels an active request and rejects already-cancelled requests', async () => {
    const controller = new AbortController();
    const generate = vi.fn(() => new Promise<never>(() => {}));
    const promise = service(generate).generate(request, { signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await Promise.resolve();
    controller.abort();
    await assertion;
    generate.mockClear();
    await expect(
      service(generate).generate(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    expect(generate).not.toHaveBeenCalled();
  });
  it('redacts upstream errors containing secrets or prompt text', async () => {
    const error = await service(async () => {
      throw new Error('secret-key private prompt');
    })
      .generate(request)
      .catch((error) => error);
    expect(error.code).toBe('AI_UPSTREAM_ERROR');
    expect(String(error)).not.toContain('secret-key');
    expect(error.cause).toBeUndefined();
  });
});
