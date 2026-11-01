import Anthropic from '@anthropic-ai/sdk';
import type { Settings } from '../shared/types';

export type ContentBlock = Anthropic.Messages.ContentBlockParam;

export type ToolDef = { name: string; description: string; input_schema: object };

export type CallToolArgs = {
  settings: Settings;
  system: string;
  content: ContentBlock[];
  tool: ToolDef;
  maxTokens: number;
};

const MSG_AUTH = 'Your Anthropic API key was rejected. Check it in Settings.';
const MSG_RATE = 'Anthropic rate limit hit. Wait a minute and retry.';
const MSG_NETWORK = "Couldn't reach Anthropic. Check your connection.";

function friendlyError(err: unknown): Error {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) return new Error(MSG_AUTH);
  if (status === 429) return new Error(MSG_RATE);
  const ctor = (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? '';
  if (err instanceof TypeError || /^APIConnection/.test(ctor)) return new Error(MSG_NETWORK);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Sends one forced-tool request and returns the tool_use input. Errors are mapped
 * to plain-English messages.
 */
export async function callTool(args: CallToolArgs): Promise<unknown> {
  const client = new Anthropic({ apiKey: args.settings.apiKey, dangerouslyAllowBrowser: true });
  let res;
  try {
    res = await client.messages.create({
      model: args.settings.model,
      max_tokens: args.maxTokens,
      system: args.system,
      tools: [args.tool as Anthropic.Messages.Tool],
      tool_choice: { type: 'tool', name: args.tool.name },
      messages: [{ role: 'user', content: args.content }],
    });
  } catch (err) {
    throw friendlyError(err);
  }
  const block = res.content.find((b) => b.type === 'tool_use' && b.name === args.tool.name);
  if (!block || block.type !== 'tool_use') throw new Error('The model returned no result. Try again.');
  return block.input;
}
