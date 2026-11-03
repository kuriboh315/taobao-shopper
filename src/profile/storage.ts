import { DEFAULT_PROFILE, ProfileSchema, SettingsSchema } from '../shared/schemas';
import type {
  FitPref, ProductData, Profile, Review, ReviewAnalysis, Settings, SizeChart,
} from '../shared/types';

/** Cached inputs for one item. Fit is recomputed from the current profile on every render. */
export type CachedRun = {
  at: number;
  product: ProductData;
  reviews: Review[];
  chart: SizeChart;
  analysis: ReviewAnalysis | null;
  fitOverride?: FitPref;
};

const MAX_CACHED = 50;
const CACHE_PREFIX = 'cache:';
const cacheKey = (itemId: string) => `${CACHE_PREFIX}${itemId}`;

async function readKey(key: string): Promise<unknown> {
  const got = await chrome.storage.local.get(key);
  return got[key];
}

export async function loadProfile(): Promise<Profile> {
  const parsed = ProfileSchema.safeParse(await readKey('profile'));
  return parsed.success ? (parsed.data as Profile) : DEFAULT_PROFILE;
}

/** Validates first; throws a ZodError on invalid input. */
export async function saveProfile(p: Profile): Promise<void> {
  const valid = ProfileSchema.parse(p);
  await chrome.storage.local.set({ profile: valid });
}

/** Returns null when no API key is stored (or stored settings are invalid). */
export async function loadSettings(): Promise<Settings | null> {
  const parsed = SettingsSchema.safeParse(await readKey('settings'));
  if (!parsed.success || !parsed.data.apiKey) return null;
  return parsed.data;
}

export async function saveSettings(s: Settings): Promise<void> {
  const valid = SettingsSchema.parse(s);
  await chrome.storage.local.set({ settings: valid });
}

export async function getCachedReport(itemId: string): Promise<CachedRun | null> {
  const run = await readKey(cacheKey(itemId));
  return run ? (run as CachedRun) : null;
}

export async function putCachedReport(itemId: string, run: CachedRun): Promise<void> {
  const existing = await getCachedReport(itemId);
  const next: CachedRun = { ...run };
  if (next.fitOverride === undefined && existing?.fitOverride) next.fitOverride = existing.fitOverride;
  await chrome.storage.local.set({ [cacheKey(itemId)]: next });

  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(CACHE_PREFIX))
    .map(([k, v]) => [k, (v as CachedRun).at ?? 0] as const)
    .sort((a, b) => a[1] - b[1]);
  const excess = entries.length - MAX_CACHED;
  if (excess > 0) await chrome.storage.local.remove(entries.slice(0, excess).map(([k]) => k));
}

/** Sets (or, with null, clears) the remembered fit choice. No-op if the item isn't cached. */
export async function setFitOverride(itemId: string, pref: FitPref | null): Promise<void> {
  const existing = await getCachedReport(itemId);
  if (!existing) return;
  const next: CachedRun = { ...existing };
  if (pref === null) delete next.fitOverride;
  else next.fitOverride = pref;
  await chrome.storage.local.set({ [cacheKey(itemId)]: next });
}
