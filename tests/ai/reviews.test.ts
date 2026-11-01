import { describe, it, expect, vi } from 'vitest';
import { analyzeReviews, validateAnalysis } from '../../src/ai/reviews';
import type { ReviewsDeps } from '../../src/ai/reviews';
import type { ProductData, Review, Settings } from '../../src/shared/types';

const label = (idx: number, extra: object = {}) => ({ idx, sentiment: 'pos', sizing: null, ...extra });

const settings: Settings = { apiKey: 'k', model: 'm' };
const product = {
  itemId: '1', title: 'T', skuSizes: ['M'], shop: { extra: [] },
  images: { main: [], sku: [], detail: [] },
} as ProductData;

describe('validateAnalysis', () => {
  it('drops out-of-range labels, flags and translations', () => {
    const a = validateAnalysis(
      {
        labels: [label(0), label(7)],
        liked: [],
        disliked: [],
        flags: [
          { group: 'fit', text: 'only bad', reviewIdx: [9] },
          { group: 'quality', text: 'mixed', reviewIdx: [0, 9] },
        ],
        translations: [{ idx: 1, en: 'ok' }, { idx: 5, en: 'bad' }],
      },
      3,
    );
    expect(a.labels.map((l) => l.idx)).toEqual([0]);
    expect(a.flags).toEqual([{ group: 'quality', text: 'mixed', reviewIdx: [0] }]);
    expect(a.translations).toEqual({ 1: 'ok' });
  });

  it('keeps the first label for a duplicate idx', () => {
    const a = validateAnalysis(
      { labels: [label(1, { sentiment: 'neg' }), label(1, { sentiment: 'pos' })], liked: [], disliked: [], flags: [], translations: [] },
      3,
    );
    expect(a.labels).toHaveLength(1);
    expect(a.labels[0]!.sentiment).toBe('neg');
  });

  it('caps liked and disliked at 5 and translations at 8', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    const a = validateAnalysis(
      {
        labels: [], liked: six, disliked: six, flags: [],
        translations: Array.from({ length: 12 }, (_, i) => ({ idx: i, en: `t${i}` })),
      },
      20,
    );
    expect(a.liked).toHaveLength(5);
    expect(a.disliked).toHaveLength(5);
    expect(Object.keys(a.translations)).toHaveLength(8);
    expect(a.translations[7]).toBe('t7');
    expect(a.translations[8]).toBeUndefined();
  });

  it('degrades on malformed output instead of throwing', () => {
    expect(validateAnalysis('nonsense', 3)).toEqual({ labels: [], liked: [], disliked: [], flags: [], translations: {} });
    const a = validateAnalysis({ labels: [label(0), { idx: 'x' }, 5], liked: 'no', flags: [{ group: 'bogus', text: 't', reviewIdx: [0] }] }, 3);
    expect(a.labels.map((l) => l.idx)).toEqual([0]);
    expect(a.liked).toEqual([]);
    expect(a.flags).toEqual([]);
  });
});

describe('analyzeReviews', () => {
  it('makes no call for zero reviews', async () => {
    const call = vi.fn();
    const a = await analyzeReviews([], product, settings, { call } as unknown as Partial<ReviewsDeps>);
    expect(call).not.toHaveBeenCalled();
    expect(a).toEqual({ labels: [], liked: [], disliked: [], flags: [], translations: {} });
  });

  it('sends numbered reviews with SKU, truncated to 400 chars and capped at 80', async () => {
    const call = vi.fn().mockResolvedValue({ labels: [], liked: [], disliked: [], flags: [], translations: [] });
    const reviews: Review[] = Array.from({ length: 90 }, (_, i) => ({
      id: String(i), text: i === 0 ? '长'.repeat(500) : 'ok', sku: i === 0 ? '黑色 M' : undefined,
    }));
    await analyzeReviews(reviews, product, settings, { call } as unknown as Partial<ReviewsDeps>);
    const args = call.mock.calls[0]![0];
    const text = args.content.map((b: { text?: string }) => b.text ?? '').join('\n');
    expect(text).toContain('[0] (SKU: 黑色 M)');
    expect(text).toContain('[79]');
    expect(text).not.toContain('[80]');
    expect(text).not.toContain('长'.repeat(401));
    expect(args.system).toContain('fit / quality / shop');
    expect(args.system).toContain('÷2');
  });
});
