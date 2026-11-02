import { describe, it, expect, vi } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  // Keep the real SDK error classes (static members are inherited); only replace the network call.
  class MockAnthropic extends actual.default {
    constructor(opts: ConstructorParameters<typeof actual.default>[0]) {
      super(opts);
      (this as unknown as { messages: unknown }).messages = { create };
    }
  }
  return { ...actual, default: MockAnthropic };
});

import Anthropic from '@anthropic-ai/sdk';
import { callStructured } from '../../src/ai/client';
import { expectStrictObjectSchemas } from './schemaUtil';

const schema = {
  type: 'object',
  properties: { a: { type: 'integer' }, inner: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false } },
  required: ['a', 'inner'],
  additionalProperties: false,
};

const args = {
  settings: { apiKey: 'k', model: 'm' },
  system: 's',
  content: [{ type: 'text' as const, text: 'hi' }],
  schema,
  maxTokens: 100,
};

const textReply = (text: string, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text }] });
const apiError = (status: number) => Anthropic.APIError.generate(status, { type: 'error' }, 'boom', new Headers());

describe('callStructured', () => {
  it('sends output_config json_schema and no tools, tool_choice or sampling params', async () => {
    create.mockResolvedValueOnce(textReply('{"a":1}'));
    await callStructured(args);
    const req = create.mock.calls.at(-1)![0];
    expect(req.tool_choice).toBeUndefined();
    expect(req.tools).toBeUndefined();
    expect(req.temperature).toBeUndefined();
    expect(req.top_p).toBeUndefined();
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.output_config.format.schema).toBe(schema);
    expect(req.output_config.effort).toBe('medium');
    expectStrictObjectSchemas(req.output_config.format.schema);
  });

  it('parses the first text block as JSON', async () => {
    create.mockResolvedValueOnce(textReply('{"a":1,"inner":{"b":"x"}}'));
    expect(await callStructured(args)).toEqual({ a: 1, inner: { b: 'x' } });
  });

  it('maps a refusal to the declined message', async () => {
    create.mockResolvedValueOnce(textReply('', 'refusal'));
    await expect(callStructured(args)).rejects.toThrow('Claude declined to analyse this item.');
  });

  it('maps max_tokens to the cut-off message', async () => {
    create.mockResolvedValueOnce(textReply('{"a":', 'max_tokens'));
    await expect(callStructured(args)).rejects.toThrow('The analysis was cut off. Try again.');
  });

  it('maps malformed JSON to the unreadable-answer message', async () => {
    create.mockResolvedValueOnce(textReply('not json'));
    await expect(callStructured(args)).rejects.toThrow('Claude returned an unreadable answer. Try again.');
  });

  it('treats a reply with no text block as unreadable', async () => {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });
    await expect(callStructured(args)).rejects.toThrow('Claude returned an unreadable answer. Try again.');
  });

  it('maps a 401 to the settings message', async () => {
    create.mockRejectedValueOnce(apiError(401));
    await expect(callStructured(args)).rejects.toThrow('Your Anthropic API key was rejected. Check it in Settings.');
  });

  it('maps a 429 to the rate limit message', async () => {
    create.mockRejectedValueOnce(apiError(429));
    await expect(callStructured(args)).rejects.toThrow('Anthropic rate limit hit. Wait a minute and retry.');
  });

  it('maps a 400 BadRequestError to the generic API message with the status', async () => {
    create.mockRejectedValueOnce(apiError(400));
    await expect(callStructured(args)).rejects.toThrow('Anthropic API error (400). Try again or check Settings.');
  });

  it('maps a 500 to the generic API message with the status', async () => {
    create.mockRejectedValueOnce(apiError(500));
    await expect(callStructured(args)).rejects.toThrow('Anthropic API error (500). Try again or check Settings.');
  });

  it('maps an APIConnectionError to the connection message', async () => {
    create.mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: 'down' }));
    await expect(callStructured(args)).rejects.toThrow("Couldn't reach Anthropic. Check your connection.");
  });

  it('maps a raw fetch TypeError to the connection message', async () => {
    create.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(callStructured(args)).rejects.toThrow("Couldn't reach Anthropic. Check your connection.");
  });
});
