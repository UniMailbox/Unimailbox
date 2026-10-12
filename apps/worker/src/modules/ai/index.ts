import {
  aiGenerateRequestSchema,
  type AiAdapter,
  type AiConfiguration,
  type AiProtocol,
  type AiService,
} from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';

export function createAiService(dependencies: {
  loadConfiguration: () => Promise<{ configuration: AiConfiguration; apiKey: string | null }>;
  adapters: Readonly<Record<AiProtocol, AiAdapter<AbortSignal>>>;
}): AiService<AbortSignal> {
  return {
    async generate(input, options = {}) {
      const request = aiGenerateRequestSchema.parse(input);
      const { configuration, apiKey } = await dependencies.loadConfiguration();
      if (!configuration.enabled)
        throw new DomainError({ code: 'AI_DISABLED', message: 'AI is disabled', httpStatus: 503 });
      if (configuration.protocol !== 'workers-ai' && !apiKey)
        throw new DomainError({
          code: 'AI_NOT_CONFIGURED',
          message: 'AI credentials are unavailable',
          httpStatus: 503,
        });
      const controller = new AbortController();
      let timedOut = false;
      const cancelled = (): DomainError =>
        new DomainError({
          code: timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED',
          message: timedOut ? 'AI request timed out' : 'AI request cancelled',
          httpStatus: timedOut ? 503 : 400,
        });
      const onAbort = (): void => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) controller.abort();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, configuration.timeoutMs);
      let rejectAbort: (() => void) | undefined;
      try {
        if (controller.signal.aborted) throw cancelled();
        // Native Workers AI cannot abort its upstream run; race still bounds caller latency.
        const abort = new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(cancelled());
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        return await Promise.race([
          dependencies.adapters[configuration.protocol].generate(
            configuration,
            apiKey,
            request,
            controller.signal,
          ),
          abort,
        ]);
      } catch (error) {
        if (controller.signal.aborted) throw cancelled();
        if (error instanceof DomainError) throw error;
        // Do not retain SDK errors: they may contain prompts, headers or upstream bodies.
        throw new DomainError({
          code: 'AI_UPSTREAM_ERROR',
          message: 'AI service request failed',
          httpStatus: 502,
        });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      }
    },
  };
}
