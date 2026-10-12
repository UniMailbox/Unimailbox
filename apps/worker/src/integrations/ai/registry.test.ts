import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_CONFIGURATION, type AiGenerateRequest } from '@unimailbox/contracts';
import { createAiAdapters } from './registry';

const request: AiGenerateRequest = {
  system: 'Be concise',
  messages: [{ role: 'user', content: 'Hi' }],
  output: { type: 'text' },
};
const structured: AiGenerateRequest = {
  ...request,
  output: {
    type: 'json_schema',
    name: 'answer',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
};
const signal = new AbortController().signal;
const openaiResponse = (content = 'Hello') => ({
  id: 'chat-1',
  object: 'chat.completion',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
});
const anthropicResponse = (text = 'Hello') => ({
  id: 'msg-1',
  type: 'message',
  role: 'assistant',
  model: 'test-model',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 3 },
});

for (const protocol of ['openai', 'anthropic'] as const) {
  describe(`${protocol} SDK adapter`, () => {
    it('uses custom base URL, auth and provider-specific system messages', async () => {
      let sentBody: Record<string, unknown> = {};
      let sentUrl = '';
      let sentHeaders = new Headers();
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sentUrl = String(input);
        sentBody = JSON.parse(String(init?.body));
        sentHeaders = new Headers(init?.headers);
        return Response.json(protocol === 'openai' ? openaiResponse() : anthropicResponse());
      });
      const result = await createAiAdapters(undefined, fetchImpl)[protocol].generate(
        {
          ...DEFAULT_AI_CONFIGURATION,
          protocol,
          model: 'test-model',
          baseUrl: 'https://ai.example.com/gateway',
        },
        'test-key',
        request,
        signal,
      );
      expect(sentUrl).toBe(
        `https://ai.example.com/gateway/${protocol === 'openai' ? 'chat/completions' : 'v1/messages'}`,
      );
      expect(sentHeaders.get(protocol === 'openai' ? 'authorization' : 'x-api-key')).toBe(
        protocol === 'openai' ? 'Bearer test-key' : 'test-key',
      );
      expect(sentBody.stream).toBe(false);
      if (protocol === 'anthropic') {
        expect(sentBody.system).toBe('Be concise');
        expect(sentBody.messages).toEqual(request.messages);
      } else
        expect(sentBody.messages).toEqual([
          { role: 'system', content: 'Be concise' },
          ...request.messages,
        ]);
      expect(result).toMatchObject({
        protocol,
        text: 'Hello',
        json: null,
        usage: { inputTokens: 7, outputTokens: 3 },
      });
    });
    it('maps JSON schema options and validates returned JSON', async () => {
      let sentBody: Record<string, unknown> = {};
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json(
          protocol === 'openai'
            ? openaiResponse('{"answer":"yes"}')
            : anthropicResponse('{"answer":"yes"}'),
        );
      });
      const result = await createAiAdapters(undefined, fetchImpl)[protocol].generate(
        { ...DEFAULT_AI_CONFIGURATION, protocol, model: 'test-model' },
        'test-key',
        structured,
        signal,
      );
      expect(sentBody[protocol === 'openai' ? 'response_format' : 'output_config']).toBeDefined();
      expect(result.json).toEqual({ answer: 'yes' });
    });
    it('rejects malformed JSON, schema mismatch and incomplete output', async () => {
      for (const text of ['not json', '{"answer":123}']) {
        const fetchImpl = vi.fn(async () =>
          Response.json(protocol === 'openai' ? openaiResponse(text) : anthropicResponse(text)),
        );
        await expect(
          createAiAdapters(undefined, fetchImpl)[protocol].generate(
            { ...DEFAULT_AI_CONFIGURATION, protocol, model: 'test-model' },
            'test-key',
            structured,
            signal,
          ),
        ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
      }
      const response =
        protocol === 'openai'
          ? {
              ...openaiResponse(),
              choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
            }
          : { ...anthropicResponse(), stop_reason: 'max_tokens' };
      await expect(
        createAiAdapters(undefined, async () => Response.json(response))[protocol].generate(
          { ...DEFAULT_AI_CONFIGURATION, protocol, model: 'test-model' },
          'test-key',
          request,
          signal,
        ),
      ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    });
    it('does not retry failed inference calls', async () => {
      const fetchImpl = vi.fn(async () =>
        Response.json(
          { error: { message: 'private prompt', type: 'server_error' } },
          { status: 500 },
        ),
      );
      await expect(
        createAiAdapters(undefined, fetchImpl)[protocol].generate(
          { ...DEFAULT_AI_CONFIGURATION, protocol, model: 'test-model' },
          'test-key',
          request,
          signal,
        ),
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
}

describe('Workers AI adapter', () => {
  it('uses the native binding and handles object-valued JSON output', async () => {
    const run = vi.fn(async () => ({
      response: { answer: 'yes' },
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }));
    const result = await createAiAdapters({ run } as unknown as Ai)['workers-ai'].generate(
      { ...DEFAULT_AI_CONFIGURATION, model: '@cf/test/model' },
      null,
      structured,
      signal,
    );
    expect(run).toHaveBeenCalledWith(
      '@cf/test/model',
      expect.objectContaining({
        response_format: {
          type: 'json_schema',
          json_schema: structured.output.type === 'json_schema' ? structured.output.schema : {},
        },
        stream: false,
      }),
    );
    expect(result.json).toEqual({ answer: 'yes' });
  });
  it('fails explicitly without the binding or for a non-text model result', async () => {
    await expect(
      createAiAdapters()['workers-ai'].generate(DEFAULT_AI_CONFIGURATION, null, request, signal),
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    await expect(
      createAiAdapters({ run: async () => ({ data: [[1, 2]] }) } as unknown as Ai)[
        'workers-ai'
      ].generate(DEFAULT_AI_CONFIGURATION, null, request, signal),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });
});

describe('AI final-answer text', () => {
  for (const protocol of ['workers-ai', 'openai', 'anthropic'] as const) {
    const generate = async (text: string, input = request) => {
      const adapters = createAiAdapters(
        { run: async () => ({ response: text }) } as unknown as Ai,
        async () =>
          Response.json(protocol === 'openai' ? openaiResponse(text) : anthropicResponse(text)),
      );
      return adapters[protocol].generate(
        { ...DEFAULT_AI_CONFIGURATION, protocol, model: 'test-model' },
        'test-key',
        input,
        signal,
      );
    };
    it(`${protocol} removes reasoning blocks and preserves only the email body`, async () => {
      for (const text of [
        '<think>Private reasoning\nover multiple lines.</think>\n\nHello <team>,\nThanks & regards.',
        '<THINK >outer<think>nested</think>reasoning</THINK>\nHello <team>,\nThanks & regards.',
        'Hello <team>,<think>first</think>\nThanks & regards.<think>second</think>',
        'Hello <team>,\nThanks & regards.<think>unfinished reasoning',
        'Hello <team>,\nThanks & regards.',
      ]) {
        expect((await generate(text)).text).toBe('Hello <team>,\nThanks & regards.');
      }
    });
    it(`${protocol} rejects reasoning-only or malformed final answers`, async () => {
      for (const text of [
        '<think>reasoning</think>\n ',
        '<think>unfinished',
        'reasoning</think>OK',
      ]) {
        await expect(generate(text)).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
      }
    });
    it(`${protocol} preserves literal think tags in structured JSON`, async () => {
      expect((await generate('{"answer":"<think>literal</think>"}', structured)).json).toEqual({
        answer: '<think>literal</think>',
      });
    });
  }
});
