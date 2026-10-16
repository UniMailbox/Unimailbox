import {
  aiGenerateRequestSchema,
  type AiAdapter,
  type AiConfiguration,
  type AiProtocol,
  type AiService,
} from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import type { AiUsageEvidence } from '@unimailbox/contracts';
import type { AiGovernance } from './governance';
export { createAiGovernance } from './governance';

export function createAiService(dependencies: {
  loadConfiguration: () => Promise<{
    configuration: AiConfiguration;
    apiKey: string | null;
    revision?: number;
  }>;
  governance?: AiGovernance;
  adapters: Readonly<Record<AiProtocol, AiAdapter<AbortSignal>>>;
}): AiService<AbortSignal> {
  return {
    async generate(input, options = {}) {
      const request = aiGenerateRequestSchema.parse(input);
      const { configuration, apiKey, revision } = await dependencies.loadConfiguration();
      if (!configuration.enabled)
        throw new DomainError({ code: 'AI_DISABLED', message: 'AI is disabled', httpStatus: 503 });
      if (configuration.protocol !== 'workers-ai' && !apiKey)
        throw new DomainError({
          code: 'AI_NOT_CONFIGURED',
          message: 'AI credentials are unavailable',
          httpStatus: 503,
        });
      if (options.signal?.aborted)
        throw new DomainError({
          code: 'AI_CANCELLED',
          message: 'AI request cancelled before submission',
          httpStatus: 400,
        });
      if (dependencies.governance && !options.invocation)
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'AI invocation identity required',
          httpStatus: 401,
        });
      const attemptId =
        dependencies.governance && options.invocation
          ? await dependencies.governance.reserve(
              configuration,
              revision ?? 0,
              request,
              options.invocation,
            )
          : null;
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
      let evidence: AiUsageEvidence | undefined;
      let adapterStarted = false;
      try {
        if (controller.signal.aborted) throw cancelled();
        // Native Workers AI cannot abort its upstream run; race still bounds caller latency.
        const abort = new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(cancelled());
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        // This continuation also handles a late result after the caller's race
        // has ended. Durable unknown holds remain safe if the isolate dies.
        adapterStarted = true;
        const execution = dependencies.adapters[configuration.protocol]
          .generate(configuration, apiKey, request, controller.signal, async (observed) => {
            evidence = observed;
            if (attemptId) await dependencies.governance?.recordEvidence(attemptId, observed);
          })
          .then(
            async (result) => {
              if (attemptId)
                await dependencies.governance?.transition(
                  attemptId,
                  'success',
                  evidence ?? result.usage,
                );
              return result;
            },
            async (error: unknown) => {
              if (attemptId)
                await dependencies.governance?.transition(
                  attemptId,
                  evidence ? 'failed' : 'unknown',
                  evidence,
                );
              throw error;
            },
          );
        return await Promise.race([execution, abort]);
      } catch (error) {
        if (attemptId)
          await dependencies.governance?.transition(
            attemptId,
            adapterStarted ? 'unknown' : 'failed',
            adapterStarted ? undefined : { inputTokens: 0, outputTokens: 0 },
          );
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
