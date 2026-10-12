import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_CONFIGURATION, type AiGenerateRequest } from '@unimailbox/contracts';
import { createAiAdapters } from './registry';

const request: AiGenerateRequest = {
  messages: [{ role: 'user', content: 'fixture' }],
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
// Actual workerd + actual SDK code; only upstream HTTP/binding responses are synthetic.
describe('AI structured output in workerd', () => {
  for (const protocol of ['workers-ai', 'openai', 'anthropic'] as const) {
    it(`${protocol} validates JSON without dynamic code generation`, async () => {
      for (const answer of ['yes', 123]) {
        const text = JSON.stringify({ answer });
        const fetchImpl: typeof fetch = async () =>
          Response.json(
            protocol === 'openai'
              ? {
                  id: 'fixture',
                  model: 'fixture',
                  choices: [
                    { message: { role: 'assistant', content: text }, finish_reason: 'stop' },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                }
              : {
                  id: 'fixture',
                  type: 'message',
                  role: 'assistant',
                  model: 'fixture',
                  content: [{ type: 'text', text }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
          );
        const adapters = createAiAdapters(
          { run: async () => ({ response: text }) } as unknown as Ai,
          fetchImpl,
        );
        const generated = adapters[protocol].generate(
          { ...DEFAULT_AI_CONFIGURATION, protocol, model: 'fixture' },
          'fixture-key',
          request,
          new AbortController().signal,
        );
        if (answer === 'yes') expect((await generated).json).toEqual({ answer: 'yes' });
        else await expect(generated).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
      }
    });
  }
});
