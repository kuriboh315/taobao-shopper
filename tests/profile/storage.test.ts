import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  loadProfile, saveProfile, loadSettings, saveSettings,
  getCachedReport, putCachedReport, setFitOverride, type CachedRun,
} from '../../src/profile/storage';
import { DEFAULT_PROFILE } from '../../src/shared/schemas';
import type { Profile } from '../../src/shared/types';

let data: Record<string, unknown>;

beforeEach(() => {
  data = {};
  const local = {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    }),
    set: vi.fn(async (o: Record<string, unknown>) => { Object.assign(data, structuredClone(o)); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local } };
});

const profile: Profile = {
  body: { heightCm: 175, chest: 96 },
  garments: { top: { label: 'M', measures: { chest: { value: 110, tag: 'just_right' } } } },
  prefs: { top: 'fitted', outerwear: 'true_to_size', bottom: 'true_to_size', shoe: 'true_to_size' },
};

const run = (at: number, extra: Partial<CachedRun> = {}): CachedRun => ({
  at,
  product: { itemId: 'x', title: 't', skuSizes: [], shop: { extra: [] }, images: { main: [], sku: [], detail: [] } },
  reviews: [],
  chart: { found: false, category: 'top', rows: [], hwTable: [] },
  analysis: null,
  ...extra,
});

describe('profile', () => {
  it('round-trips', async () => {
    await saveProfile(profile);
    expect(await loadProfile()).toEqual(profile);
  });
  it('returns the default when empty', async () => {
    expect(await loadProfile()).toEqual(DEFAULT_PROFILE);
  });
  it('returns the default when stored data is invalid', async () => {
    data.profile = { body: { chest: 'wide' } };
    expect(await loadProfile()).toEqual(DEFAULT_PROFILE);
  });
  it('throws a ZodError when saving invalid input', async () => {
    const bad = { ...profile, body: { chest: 9999 } } as Profile;
    await expect(saveProfile(bad)).rejects.toBeInstanceOf(ZodError);
    expect(data.profile).toBeUndefined();
  });
});

describe('settings', () => {
  it('returns null when nothing is stored or the key is empty', async () => {
    expect(await loadSettings()).toBeNull();
    await saveSettings({ apiKey: '', model: 'm' });
    expect(await loadSettings()).toBeNull();
  });
  it('round-trips', async () => {
    await saveSettings({ apiKey: 'sk-1', model: 'm', fallbackCnyToCad: 0.19 });
    expect(await loadSettings()).toEqual({ apiKey: 'sk-1', model: 'm', fallbackCnyToCad: 0.19 });
  });
});

describe('report cache', () => {
  it('returns null for unknown items', async () => {
    expect(await getCachedReport('nope')).toBeNull();
  });
  it('stores and reads a run', async () => {
    await putCachedReport('1', run(5));
    expect((await getCachedReport('1'))?.at).toBe(5);
  });
  it('evicts the oldest after 50 entries', async () => {
    for (let i = 0; i < 51; i++) await putCachedReport(`i${i}`, run(1000 + i));
    expect(await getCachedReport('i0')).toBeNull();
    expect(await getCachedReport('i1')).not.toBeNull();
    expect(await getCachedReport('i50')).not.toBeNull();
    expect(Object.keys(data).filter((k) => k.startsWith('cache:'))).toHaveLength(50);
  });
  it('sets and clears a fit override', async () => {
    await putCachedReport('1', run(1));
    await setFitOverride('1', 'oversized');
    expect((await getCachedReport('1'))?.fitOverride).toBe('oversized');
    await setFitOverride('1', null);
    expect((await getCachedReport('1'))?.fitOverride).toBeUndefined();
  });
  it('ignores an override for an uncached item', async () => {
    await setFitOverride('ghost', 'fitted');
    expect(data['cache:ghost']).toBeUndefined();
  });
  it('keeps the existing override when an item is re-analysed', async () => {
    await putCachedReport('1', run(1, { fitOverride: 'fitted' }));
    await putCachedReport('1', run(2));
    const got = await getCachedReport('1');
    expect(got?.at).toBe(2);
    expect(got?.fitOverride).toBe('fitted');
  });
});
