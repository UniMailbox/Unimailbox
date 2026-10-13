import { describe, expect, it } from 'vitest';
import { buildMcpPrompt, mcpConfigurationSchema, DEFAULT_MCP_CONFIGURATION } from './mcp';

describe('MCP shared setup prompt', () => {
  it('fills all endpoint placeholders and always includes credential and send protection', () => {
    const prompt = buildMcpPrompt(
      'https://mail.example.test/api/mcp',
      'Agent setup: {{endpoint}} / {{endpoint}}',
    );
    expect(prompt.match(/https:\/\/mail.example.test\/api\/mcp/g)).toHaveLength(2);
    expect(prompt).toContain('UNIMAILBOX_MCP_TOKEN');
    expect(prompt).toContain('explicit human approval');
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('Quick settings');
  });
  it('requires a service URL placeholder and rejects copied credentials and retired global controls', () => {
    expect(mcpConfigurationSchema.safeParse(DEFAULT_MCP_CONFIGURATION).success).toBe(true);
    for (const promptTemplate of [
      '',
      'No endpoint',
      '{{endpoint}} umcp_' + 'a'.repeat(64),
      '{{endpoint}}' + 'x'.repeat(8000),
    ])
      expect(mcpConfigurationSchema.safeParse({ enabled: true, promptTemplate }).success).toBe(
        false,
      );
    expect(
      mcpConfigurationSchema.safeParse({ ...DEFAULT_MCP_CONFIGURATION, allowSend: true }).success,
    ).toBe(false);
  });
});
