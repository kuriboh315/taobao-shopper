import { z } from 'zod';
import type { FxRate, ProductData, Settings } from './types';

export const FX_URL = 'https://api.frankfurter.app/latest?from=CNY&to=CAD';

const CACHE_KEY = 'fx:CNY-CAD';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const rate = z.number().min(0.05).max(1);
const FxResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rates: z.object({ CAD: rate }),
});
const FxCacheSchema = z.object({ rate, date: z.string(), fetchedAt: z.number() });

export interface FxDeps {
  fetch: typeof fetch;
  now: () => number;
  storage: chrome.storage.LocalStorageArea;
}

function defaultDeps(): FxDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    now: () => Date.now(),
    storage: chrome.storage.local,
  };
}

/** ECB CNY->CAD rate: 24 h cache, then network, then stale cache, then the user's manual rate. Never throws. */
export async function getCnyToCad(settings: Settings | null, deps?: FxDeps): Promise<FxRate | null> {
  let d: FxDeps | undefined = deps;
  let cached: z.infer<typeof FxCacheSchema> | null = null;
  try {
    d = deps ?? defaultDeps();
    const stored = await d.storage.get(CACHE_KEY);
    const parsed = FxCacheSchema.safeParse((stored as Record<string, unknown>)[CACHE_KEY]);
    if (parsed.success) cached = parsed.data;
  } catch { /* storage unavailable: treat as no cache */ }

  const asRate = (c: z.infer<typeof FxCacheSchema>): FxRate => ({ cnyToCad: c.rate, date: c.date, source: 'ecb' });
  const now = d ? d.now() : Date.now();

  if (cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < CACHE_TTL_MS) return asRate(cached);

  try {
    if (!d) throw new Error('no deps');
    const res = await d.fetch(FX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = FxResponseSchema.parse(await res.json());
    const entry = { rate: body.rates.CAD, date: body.date, fetchedAt: now };
    try { await d.storage.set({ [CACHE_KEY]: entry }); } catch { /* cache write is best-effort */ }
    return asRate(entry);
  } catch {
    if (cached) return asRate(cached);
    const manual = settings?.fallbackCnyToCad;
    if (manual !== undefined) {
      return { cnyToCad: manual, date: new Date(now).toISOString().slice(0, 10), source: 'manual' };
    }
    return null;
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function cnyAmount(v: number): string {
  return Number.isInteger(v) ? String(v) : round2(v).toFixed(2);
}

function cadAmount(cny: number, r: number): string {
  return round2(cny * r).toFixed(2);
}

export function formatPrice(
  price: ProductData['price'],
  fx: FxRate | null,
): { cny: string; cad: string | null; coupon: string | null; rateNote: string | null } | null {
  if (!price) return null;
  const range = price.min === price.max;
  const cny = `¥${cnyAmount(price.min)}${range ? '' : `–${cnyAmount(price.max)}`}`;
  const cad = fx
    ? `CA$${cadAmount(price.min, fx.cnyToCad)}${range ? '' : `–${cadAmount(price.max, fx.cnyToCad)}`}`
    : null;
  let coupon: string | null = null;
  if (price.coupon !== undefined) {
    coupon = `Coupon ¥${cnyAmount(price.coupon)}`;
    if (fx) coupon += ` ≈ CA$${cadAmount(price.coupon, fx.cnyToCad)}`;
  }
  const rateNote = fx
    ? `1 CNY = ${fx.cnyToCad} CAD (${fx.source === 'ecb' ? `ECB, ${fx.date}` : 'your rate'})`
    : null;
  return { cny, cad, coupon, rateNote };
}
