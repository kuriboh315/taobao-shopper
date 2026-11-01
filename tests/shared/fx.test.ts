import { describe, it, expect, vi } from 'vitest';
import { getCnyToCad, formatPrice, FX_URL } from '../../src/shared/fx';
import type { FxRate, Settings } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const HOUR = 3600_000;
const KEY = 'fx:CNY-CAD';
const settings = (fallbackCnyToCad?: number): Settings => ({ apiKey: 'k', model: 'm', fallbackCnyToCad });

function makeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})),
    set: vi.fn(async (o: Record<string, unknown>) => { Object.assign(data, o); }),
  };
}
type Deps = NonNullable<Parameters<typeof getCnyToCad>[1]>;
const mk = (storage: ReturnType<typeof makeStorage>, fetchFn: unknown): Deps =>
  ({ fetch: fetchFn, now: () => NOW, storage }) as unknown as Deps;
const okFetch = (body: unknown) => vi.fn(async () => ({ ok: true, json: async () => body }));

describe('getCnyToCad', () => {
  it('uses a fresh cache without fetching', async () => {
    const storage = makeStorage({ [KEY]: { rate: 0.19, date: '2026-10-30', fetchedAt: NOW - HOUR } });
    const f = okFetch({});
    const r = await getCnyToCad(null, mk(storage, f));
    expect(f).not.toHaveBeenCalled();
    expect(r).toEqual({ cnyToCad: 0.19, date: '2026-10-30', source: 'ecb' });
  });

  it('fetches when the cache is stale and writes the cache', async () => {
    const storage = makeStorage({ [KEY]: { rate: 0.19, date: '2026-10-29', fetchedAt: NOW - 25 * HOUR } });
    const f = okFetch({ date: '2026-10-30', rates: { CAD: 0.1945 } });
    const r = await getCnyToCad(null, mk(storage, f));
    expect(f).toHaveBeenCalledWith(FX_URL);
    expect(r).toEqual({ cnyToCad: 0.1945, date: '2026-10-30', source: 'ecb' });
    expect(storage.data[KEY]).toEqual({ rate: 0.1945, date: '2026-10-30', fetchedAt: NOW });
  });

  it('falls back to the manual rate when fetch rejects and nothing is cached', async () => {
    const storage = makeStorage();
    const r = await getCnyToCad(settings(0.19), mk(storage, vi.fn(async () => { throw new Error('net'); })));
    expect(r).toEqual({ cnyToCad: 0.19, date: '2026-10-31', source: 'manual' });
  });

  it('returns null when fetch rejects with no cache and no fallback', async () => {
    const r = await getCnyToCad(settings(), mk(makeStorage(), vi.fn(async () => { throw new Error('net'); })));
    expect(r).toBeNull();
  });

  it('returns null with null settings and a failing fetch', async () => {
    const r = await getCnyToCad(null, mk(makeStorage(), vi.fn(async () => { throw new Error('net'); })));
    expect(r).toBeNull();
  });

  it('rejects an inverted-pair rate and falls back', async () => {
    const storage = makeStorage();
    const r = await getCnyToCad(settings(0.19), mk(storage, okFetch({ date: '2026-10-30', rates: { CAD: 7.2 } })));
    expect(r).toEqual({ cnyToCad: 0.19, date: '2026-10-31', source: 'manual' });
    expect(storage.data[KEY]).toBeUndefined();
  });

  it('returns the stale cache when the fetch fails', async () => {
    const storage = makeStorage({ [KEY]: { rate: 0.2, date: '2026-10-28', fetchedAt: NOW - 48 * HOUR } });
    const r = await getCnyToCad(settings(0.19), mk(storage, vi.fn(async () => { throw new Error('net'); })));
    expect(r).toEqual({ cnyToCad: 0.2, date: '2026-10-28', source: 'ecb' });
  });

  it('treats a non-ok response as a failure', async () => {
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    const r = await getCnyToCad(settings(0.19), mk(makeStorage(), f));
    expect(r?.source).toBe('manual');
  });

  it('ignores a malformed cache entry', async () => {
    const storage = makeStorage({ [KEY]: { junk: true } });
    const f = okFetch({ date: '2026-10-30', rates: { CAD: 0.1945 } });
    const r = await getCnyToCad(null, mk(storage, f));
    expect(f).toHaveBeenCalled();
    expect(r?.cnyToCad).toBe(0.1945);
  });
});

describe('formatPrice', () => {
  const ecb: FxRate = { cnyToCad: 0.1945, date: '2026-10-30', source: 'ecb' };

  it('formats a range with coupon and ECB note', () => {
    expect(formatPrice({ min: 129, max: 159, coupon: 118 }, ecb)).toEqual({
      cny: '¥129–159',
      cad: 'CA$25.09–30.93',
      coupon: 'Coupon ¥118 ≈ CA$22.95',
      rateNote: '1 CNY = 0.1945 CAD (ECB, 2026-10-30)',
    });
  });

  it('returns cad null without fx', () => {
    expect(formatPrice({ min: 129, max: 129 }, null)).toEqual({
      cny: '¥129', cad: null, coupon: null, rateNote: null,
    });
  });

  it('shows the coupon without fx and a manual rate note', () => {
    expect(formatPrice({ min: 129, max: 129, coupon: 119 }, null)?.coupon).toBe('Coupon ¥119');
    const manual: FxRate = { cnyToCad: 0.19, date: '2026-10-31', source: 'manual' };
    expect(formatPrice({ min: 129, max: 129 }, manual)?.rateNote).toBe('1 CNY = 0.19 CAD (your rate)');
  });

  it('uses 2 decimals only when yuan have cents', () => {
    expect(formatPrice({ min: 12.5, max: 129 }, null)?.cny).toBe('¥12.50–129');
  });

  it('returns null for undefined price', () => expect(formatPrice(undefined, ecb)).toBeNull());
});
