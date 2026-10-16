import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Validator } from '@cfworker/json-schema';
import { z } from 'zod';
import type {
  AiAdapter,
  AiGenerateRequest,
  AiGenerateResult,
  AiProtocol,
} from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';

const usageNumber = z.number().int().nonnegative().max(1_000_000_000);
const safeUsage = (value: unknown): number | null => {
  const parsed = usageNumber.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const nativeResponse = z.object({
  response: z.union([z.string(), z.record(z.unknown())]),
  usage: z
    .object({ prompt_tokens: usageNumber.optional(), completion_tokens: usageNumber.optional() })
    .optional(),
});
// A fresh validator per schema avoids retaining caller schemas in a global cache.
function structuredResult(text: string, request: AiGenerateRequest): unknown | null {
  if (request.output.type === 'text') return null;
  try {
    const json: unknown = JSON.parse(text);
    const validator = new Validator(request.output.schema, '7');
    if (!validator.validate(json).valid) throw new Error('Schema mismatch');
    return json;
  } catch {
    throw invalidResponse();
  }
}
function invalidResponse(): DomainError {
  return new DomainError({
    code: 'AI_INVALID_RESPONSE',
    message: 'AI returned an invalid or incomplete response',
    httpStatus: 502,
  });
}
function finalAnswer(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let depth = 0;
  // Compatible backends may inline reasoning instead of using a separate field.
  // Track nesting and discard unfinished blocks so reasoning cannot reach mail.
  for (const tag of text.matchAll(/<\/?think\s*>/gi)) {
    if (depth === 0) parts.push(text.slice(cursor, tag.index));
    if (tag[0].startsWith('</')) {
      if (depth === 0) throw invalidResponse();
      depth--;
    } else depth++;
    cursor = tag.index + tag[0].length;
  }
  if (depth === 0) parts.push(text.slice(cursor));
  return parts.join('').trim();
}
function result(
  protocol: AiProtocol,
  model: string,
  text: string,
  finishReason: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  request: AiGenerateRequest,
): AiGenerateResult {
  // Preserve literal strings inside validated JSON; this cleanup is for text.
  if (request.output.type === 'text') text = finalAnswer(text);
  if (
    !z.string().min(1).safeParse(model).success ||
    !z.string().min(1).safeParse(text).success ||
    !usageNumber.nullable().safeParse(inputTokens).success ||
    !usageNumber.nullable().safeParse(outputTokens).success ||
    ['length', 'max_tokens', 'content_filter', 'refusal', 'tool_calls', 'tool_use'].includes(
      finishReason ?? '',
    )
  )
    throw invalidResponse();
  return {
    protocol,
    model,
    text,
    json: structuredResult(text, request),
    finishReason,
    usage: { inputTokens, outputTokens },
  };
}

export function createAiAdapters(
  ai?: Ai,
  fetchImpl?: typeof fetch,
): Readonly<Record<AiProtocol, AiAdapter<AbortSignal>>> {
  return {
    'workers-ai': {
      async generate(configuration, _apiKey, request, signal, observeUsage) {
        if (!ai)
          throw new DomainError({
            code: 'AI_NOT_CONFIGURED',
            message: 'Workers AI binding is unavailable',
            httpStatus: 503,
          });
        if (signal.aborted) throw signal.reason;
        const raw = await ai.run(configuration.model, {
          messages: [
            ...(request.system ? [{ role: 'system', content: request.system }] : []),
            ...request.messages,
          ],
          max_tokens: configuration.maxOutputTokens,
          stream: false,
          ...(request.output.type === 'json_schema'
            ? {
                response_format: { type: 'json_schema', json_schema: request.output.schema },
              }
            : {}),
        });
        const metering = nativeResponse.omit({ response: true }).safeParse(raw);
        await observeUsage?.({
          inputTokens: safeUsage(metering.success ? metering.data.usage?.prompt_tokens : null),
          outputTokens: safeUsage(metering.success ? metering.data.usage?.completion_tokens : null),
        });
        const parsed = nativeResponse.safeParse(raw);
        if (!parsed.success) throw invalidResponse();
        const value = parsed.data;
        const text =
          typeof value.response === 'string' ? value.response : JSON.stringify(value.response);
        return result(
          'workers-ai',
          configuration.model,
          text,
          null,
          value.usage?.prompt_tokens ?? null,
          value.usage?.completion_tokens ?? null,
          request,
        );
      },
    },
    openai: {
      async generate(configuration, apiKey, request, signal, observeUsage) {
        const client = new OpenAI({
          apiKey: apiKey ?? '',
          baseURL: configuration.baseUrl ?? 'https://api.openai.com/v1',
          timeout: configuration.timeoutMs,
          maxRetries: 0,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        const response = await client.chat.completions.create(
          {
            model: configuration.model,
            messages: [
              ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
              ...request.messages,
            ],
            max_completion_tokens: configuration.maxOutputTokens,
            stream: false,
            ...(request.output.type === 'json_schema'
              ? {
                  response_format: {
                    type: 'json_schema' as const,
                    json_schema: {
                      name: request.output.name,
                      schema: request.output.schema,
                      strict: true,
                    },
                  },
                }
              : {}),
          },
          { signal },
        );
        await observeUsage?.({
          inputTokens: safeUsage(response.usage?.prompt_tokens),
          outputTokens: safeUsage(response.usage?.completion_tokens),
          cachedInputTokens: safeUsage(response.usage?.prompt_tokens_details?.cached_tokens),
          reasoningTokens: safeUsage(response.usage?.completion_tokens_details?.reasoning_tokens),
          providerRequestId: response.id,
        });
        const choice = response.choices?.[0];
        if (!choice?.message?.content || choice.message.refusal) throw invalidResponse();
        return result(
          'openai',
          response.model,
          choice.message.content,
          choice.finish_reason,
          response.usage?.prompt_tokens ?? null,
          response.usage?.completion_tokens ?? null,
          request,
        );
      },
    },
    anthropic: {
      async generate(configuration, apiKey, request, signal, observeUsage) {
        const client = new Anthropic({
          apiKey: apiKey ?? '',
          baseURL: configuration.baseUrl ?? 'https://api.anthropic.com',
          timeout: configuration.timeoutMs,
          maxRetries: 0,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        const response = await client.messages.create(
          {
            model: configuration.model,
            messages: request.messages,
            ...(request.system ? { system: request.system } : {}),
            max_tokens: configuration.maxOutputTokens,
            stream: false,
            ...(request.output.type === 'json_schema'
              ? {
                  output_config: {
                    format: { type: 'json_schema' as const, schema: request.output.schema },
                  },
                }
              : {}),
          },
          { signal },
        );
        const inputParts = [
          response.usage?.input_tokens,
          response.usage?.cache_read_input_tokens ?? 0,
          response.usage?.cache_creation_input_tokens ?? 0,
        ].map(safeUsage);
        const totalInput = inputParts.every((x) => x !== null)
          ? inputParts.reduce<number>((sum, x) => sum + (x ?? 0), 0)
          : null;
        await observeUsage?.({
          inputTokens: totalInput,
          outputTokens: safeUsage(response.usage?.output_tokens),
          cachedInputTokens: safeUsage(response.usage?.cache_read_input_tokens),
          providerRequestId: response.id,
        });
        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        return result(
          'anthropic',
          response.model,
          text,
          response.stop_reason,
          totalInput,
          safeUsage(response.usage?.output_tokens),
          request,
        );
      },
    },
  };
}
