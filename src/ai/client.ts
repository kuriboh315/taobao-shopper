import Anthropic from '@anthropic-ai/sdk';
import type { Settings } from '../shared/types';

export type ContentBlock = Anthropic.Messages.ContentBlockParam;

/** A JSON Schema object. Structured outputs need additionalProperties:false and `required` on every object node. */
export type JsonSchema = { [key: string]: unknown };

export type CallStructuredArgs = {
  settings: Settings;
  system: string;
  content: ContentBlock[];
  schema: JsonSchema;
  maxTokens: number;
};

const MSG_AUTH = 'Your Anthropic API key was rejected. Check it in Settings.';
const MSG_RATE = 'Anthropic rate limit hit. Wait a minute and retry.';
const MSG_NETWORK = "Couldn't reach Anthropic. Check your connection.";
const MSG_REFUSAL = 'Claude declined to analyse this item.';
const MSG_CUT_OFF = 'The analysis was cut off. Try again.';
const MSG_UNREADABLE = 'Claude returned an unreadable answer. Try again.';

function friendlyError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new Error(MSG_AUTH);
  if (err instanceof Anthropic.RateLimitError) return new Error(MSG_RATE);
  // APIConnectionError covers timeouts too; a bare TypeError is a raw fetch failure.
  if (err instanceof Anthropic.APIConnectionError || err instanceof TypeError) return new Error(MSG_NETWORK);
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error (${err.status ?? 'unknown'}). Try again or check Settings.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Sends one request with schema-constrained JSON output (structured outputs) and returns the parsed
 * JSON from the first text block. No tools, tool_choice or sampling parameters are sent. Errors are
 * mapped to plain-English messages.
 */
export async function callStructured(args: CallStructuredArgs): Promise<unknown> {
  const client = new Anthropic({ apiKey: args.settings.apiKey, dangerouslyAllowBrowser: true });
  let res;
  try {
    res = await client.messages.create({
      model: args.settings.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: [{ role: 'user', content: args.content }],
      output_config: {
        format: { type: 'json_schema', schema: args.schema },
        effort: 'medium',
      },
    });
  } catch (err) {
    throw friendlyError(err);
  }
  if (res.stop_reason === 'refusal') throw new Error(MSG_REFUSAL);
  if (res.stop_reason === 'max_tokens') throw new Error(MSG_CUT_OFF);
  const block = res.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error(MSG_UNREADABLE);
  try {
    return JSON.parse(block.text) as unknown;
  } catch {
    throw new Error(MSG_UNREADABLE);
  }
}
