import { describe, it, expect, vi } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

import { callTool } from '../../src/ai/client';

const args = {
  settings: { apiKey: 'k', model: 'm' },
  system: 's',
  content: [{ type: 'text' as const, text: 'hi' }],
  tool: { name: 't', description: 'd', input_schema: { type: 'object' } },
  maxTokens: 100,
};

describe('callTool', () => {
  it('returns the tool_use input and forces the tool', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'tool_use', name: 't', input: { a: 1 } }] });
    expect(await callTool(args)).toEqual({ a: 1 });
    expect(create.mock.calls[0]![0].tool_choice).toEqual({ type: 'tool', name: 't' });
  });

  it('maps a 401 to the settings message', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 401 }));
    await expect(callTool(args)).rejects.toThrow('Your Anthropic API key was rejected. Check it in Settings.');
  });

  it('maps a 429 to the rate limit message', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 429 }));
    await expect(callTool(args)).rejects.toThrow('Anthropic rate limit hit. Wait a minute and retry.');
  });

  it('maps a network failure to the connection message', async () => {
    create.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(callTool(args)).rejects.toThrow("Couldn't reach Anthropic. Check your connection.");
  });

  it('fails clearly when the model returns no tool call', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hm' }] });
    await expect(callTool(args)).rejects.toThrow(/no result/i);
  });
});
