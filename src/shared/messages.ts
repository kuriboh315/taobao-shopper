import type { ProductData, Review } from './types';

/** Name of the chrome.runtime port between the side panel and the content script. */
export const PORT_NAME = 'tbs';

export type StopReason = 'cap' | 'exhausted' | 'timeout' | 'user';

/** Panel to content script. */
export type PanelToContent = { type: 'collect' } | { type: 'resume' } | { type: 'finish' };

/** Content script to panel. */
export type ContentToPanel =
  | { type: 'progress'; reviews: number }
  | { type: 'captcha' }
  | { type: 'done'; product: ProductData; reviews: Review[]; stoppedBy: StopReason }
  | { type: 'error'; message: string };

/** Shallow check at the port boundary: returns the message if it has a known shape, else null. */
export function parseContentMessage(raw: unknown): ContentToPanel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'progress':
      return typeof m.reviews === 'number' ? { type: 'progress', reviews: m.reviews } : null;
    case 'captcha':
      return { type: 'captcha' };
    case 'error':
      return { type: 'error', message: typeof m.message === 'string' ? m.message : 'Something went wrong. Try again.' };
    case 'done':
      return typeof m.product === 'object' && m.product !== null && Array.isArray(m.reviews)
        ? (m as unknown as ContentToPanel)
        : null;
    default:
      return null;
  }
}
