// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPanel, type PanelDeps } from '../../src/panel/panel';
import { buildReport } from '../../src/report/build';
import { DEFAULT_PROFILE as P } from '../../src/shared/schemas';
import type { CachedRun } from '../../src/profile/storage';
import type { ContentToPanel, PanelToContent } from '../../src/shared/messages';
import type { FitPref, ProductData, Profile, SizeChart } from '../../src/shared/types';

const ITEM_URL = 'https://item.taobao.com/item.htm?id=123&spm=a1';
const profile: Profile = {
  ...P,
  body: { chest: 108, heightCm: 175, weightKg: 70 },
  garments: { top: { label: 'hoodie', measures: { chest: { value: 120, tag: 'relaxed' }, length: { value: 71, tag: 'just_right' } } } },
  prefs: { ...P.prefs, top: 'slightly_relaxed' },
};
const chart: SizeChart = {
  found: true, category: 'top', hwTable: [],
  rows: [
    { label: 'L', measures: { chest: 116, length: 70 } },
    { label: 'XL', measures: { chest: 122, length: 72 } },
    { label: 'XXL', measures: { chest: 128, length: 74 } },
  ],
};
const product: ProductData = {
  itemId: '123', title: 't', skuSizes: ['L', 'XL', 'XXL'], shop: { extra: [] }, images: { main: [], sku: [], detail: [] },
};
const reviews = [{ id: '1', text: '偏小' }, { id: '2', text: '不错' }];

function makePort() {
  const msgListeners: ((m: ContentToPanel) => void)[] = [];
  const dcListeners: (() => void)[] = [];
  const sent: PanelToContent[] = [];
  return {
    sent,
    disconnect: vi.fn(),
    postMessage: (m: PanelToContent) => { sent.push(m); },
    onMessage: { addListener: (cb: (m: ContentToPanel) => void) => { msgListeners.push(cb); } },
    onDisconnect: { addListener: (cb: () => void) => { dcListeners.push(cb); } },
    emit: (m: ContentToPanel) => msgListeners.forEach(cb => cb(m)),
    drop: () => dcListeners.forEach(cb => cb()),
  };
}

function setup(over: Partial<PanelDeps> = {}, opts: { cached?: CachedRun; settings?: boolean } = {}) {
  const cache = new Map<string, CachedRun>();
  if (opts.cached) cache.set('123', opts.cached);
  const port = makePort();
  const tabListeners: ((id?: number) => void)[] = [];
  const storageListeners: ((keys: string[]) => void)[] = [];
  let currentProfile = profile;
  const deps = {
    getActiveTab: vi.fn(async () => ({ id: 7, url: ITEM_URL })),
    connect: vi.fn(() => port),
    openOptions: vi.fn(),
    onTabChange: (cb: (id?: number) => void) => { tabListeners.push(cb); },
    onStorageChange: (cb: (keys: string[]) => void) => { storageListeners.push(cb); },
    loadProfile: vi.fn(async () => currentProfile),
    loadSettings: vi.fn(async () => (opts.settings === false ? null : { apiKey: 'k', model: 'm' })),
    getCachedReport: vi.fn(async (id: string) => cache.get(id) ?? null),
    putCachedReport: vi.fn(async (id: string, run: CachedRun) => { cache.set(id, run); }),
    setFitOverride: vi.fn(async (id: string, pref: FitPref | null) => {
      const c = cache.get(id);
      if (!c) return;
      const next = { ...c };
      if (pref === null) delete next.fitOverride; else next.fitOverride = pref;
      cache.set(id, next);
    }),
    readSizeChart: vi.fn(async () => chart),
    analyzeReviews: vi.fn(async () => ({ labels: [], liked: ['soft'], disliked: [], flags: [], translations: {} })),
    getCnyToCad: vi.fn(async () => null),
    buildReport,
    now: () => 5_000_000,
    ...over,
  } satisfies PanelDeps;
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root')!;
  return {
    root, deps, port, cache,
    start: () => createPanel(root, deps).refresh(),
    changeProfile: (p: Profile) => { currentProfile = p; storageListeners.forEach(cb => cb(['profile'])); },
    changeTab: (id?: number) => tabListeners.forEach(cb => cb(id)),
  };
}

const text = (root: HTMLElement) => root.textContent ?? '';
const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll('button')].find(b => b.textContent === label)!;
const waitFor = (root: HTMLElement, s: string) => vi.waitFor(() => expect(text(root)).toContain(s));
const cachedRun = (over: Partial<CachedRun> = {}): CachedRun => ({
  at: 4_000_000, product, reviews, chart,
  analysis: { labels: [], liked: ['soft'], disliked: [], flags: [], translations: {} },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('panel states on load', () => {
  it('shows not_taobao for other sites', async () => {
    const t = setup({ getActiveTab: vi.fn(async () => ({ id: 1, url: 'https://www.baidu.com' })) });
    await t.start();
    await waitFor(t.root, 'Open a Taobao or Tmall product page to analyse it.');
  });

  it('shows no_settings and opens the options page', async () => {
    const t = setup({}, { settings: false });
    await t.start();
    await waitFor(t.root, 'Add your Anthropic API key in Settings first.');
    button(t.root, 'Open Settings').click();
    expect(t.deps.openOptions).toHaveBeenCalledOnce();
  });

  it('shows idle when nothing is cached', async () => {
    const t = setup();
    await t.start();
    await vi.waitFor(() => expect(button(t.root, 'Analyse this product')).toBeDefined());
  });

  it('renders the cached report immediately without any API call', async () => {
    const t = setup({}, { cached: cachedRun() });
    await t.start();
    await waitFor(t.root, 'Chart says XL');
    expect(text(t.root)).toContain('Analysed 16 minutes ago');
    expect(t.deps.readSizeChart).not.toHaveBeenCalled();
    expect(t.deps.analyzeReviews).not.toHaveBeenCalled();
    expect(t.deps.connect).not.toHaveBeenCalled();
  });

  it('the Settings button opens the options page in the report and idle states', async () => {
    const settingsBtn = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('button[aria-label="Edit sizing settings"]')!;
    const idle = setup();
    await idle.start();
    await vi.waitFor(() => expect(button(idle.root, 'Analyse this product')).toBeDefined());
    settingsBtn(idle.root).click();
    expect(idle.deps.openOptions).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    const rep = setup({}, { cached: cachedRun() });
    await rep.start();
    await waitFor(rep.root, 'Chart says XL');
    settingsBtn(rep.root).click();
    expect(rep.deps.openOptions).toHaveBeenCalledOnce();
  });

  it('re-checks the active tab when tabs change', async () => {
    const t = setup({}, { cached: cachedRun() });
    await t.start();
    await waitFor(t.root, 'Chart says XL');
    (t.deps.getActiveTab as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 2, url: 'https://www.baidu.com' });
    t.changeTab();
    await waitFor(t.root, 'Open a Taobao or Tmall product page');
  });
});

describe('analysis flow', () => {
  it('goes through captcha, resume, and renders the report', async () => {
    const t = setup();
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    expect(t.deps.connect).toHaveBeenCalledWith(7);
    expect(t.port.sent).toEqual([{ type: 'collect' }]);

    t.port.emit({ type: 'progress', reviews: 12 });
    await waitFor(t.root, 'Reading reviews (12 so far)…');

    t.port.emit({ type: 'captcha' });
    await waitFor(t.root, 'Taobao is asking for a verification. Solve it in the page, then click Continue.');
    button(t.root, 'Continue').click();
    expect(t.port.sent.filter(m => m.type === 'resume')).toHaveLength(1);

    t.port.emit({ type: 'done', product, reviews, stoppedBy: 'exhausted' });
    await waitFor(t.root, 'Chart says XL');
    expect(t.deps.readSizeChart).toHaveBeenCalledOnce();
    expect(t.deps.analyzeReviews).toHaveBeenCalledOnce();
    expect(t.deps.putCachedReport).toHaveBeenCalledOnce();
    expect(vi.mocked(t.deps.putCachedReport).mock.calls[0]![0]).toBe('123');
  });

  it('always reads the photos and fills gaps from the structured chart', async () => {
    const structured: SizeChart = {
      found: true, category: 'top', hwTable: [],
      rows: [{ label: 'XL', measures: { chest: 999, shoulder: 50 } }],
    };
    const t = setup();
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.emit({ type: 'done', product: { ...product, sizeChart: structured }, reviews, stoppedBy: 'exhausted' });
    await waitFor(t.root, 'Chart says XL');
    expect(t.deps.readSizeChart).toHaveBeenCalledOnce();
    const saved = vi.mocked(t.deps.putCachedReport).mock.calls[0]![1].chart;
    expect(saved.rows.find(r => r.label === 'XL')!.measures).toEqual({ chest: 122, length: 72, shoulder: 50 });
  });

  it('uses the structured chart when the photos have none', async () => {
    const structured: SizeChart = { ...chart, rows: chart.rows.slice(0, 2) };
    const t = setup({ readSizeChart: vi.fn(async () => ({ found: false, category: 'other' as const, rows: [], hwTable: [] })) });
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.emit({ type: 'done', product: { ...product, sizeChart: structured }, reviews, stoppedBy: 'exhausted' });
    await waitFor(t.root, 'Chart says XL');
    expect(t.deps.readSizeChart).toHaveBeenCalledOnce();
    expect(vi.mocked(t.deps.putCachedReport).mock.calls[0]![1].chart).toEqual(structured);
  });

  it('accepts Tmall product pages', async () => {
    const t = setup({ getActiveTab: vi.fn(async () => ({ id: 7, url: 'https://detail.tmall.com/item.htm?id=123' })) });
    await t.start();
    await vi.waitFor(() => expect(button(t.root, 'Analyse this product')).toBeDefined());
  });

  it('"Use what you have" sends finish', async () => {
    const t = setup();
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.emit({ type: 'captcha' });
    await vi.waitFor(() => button(t.root, 'Use what you have').click());
    expect(t.port.sent).toContainEqual({ type: 'finish' });
  });

  it('shows the plain-English message and Retry when the chart step fails', async () => {
    const msg = 'Your Anthropic API key was rejected. Check it in Settings.';
    const t = setup({ readSizeChart: vi.fn(async () => { throw new Error(msg); }) });
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.emit({ type: 'done', product, reviews, stoppedBy: 'exhausted' });
    await waitFor(t.root, msg);
    expect(button(t.root, 'Retry')).toBeDefined();
    expect(t.deps.putCachedReport).not.toHaveBeenCalled();
  });

  it('renders the report with "No reviews found" when done has zero reviews', async () => {
    const t = setup();
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.emit({ type: 'done', product, reviews: [], stoppedBy: 'exhausted' });
    await waitFor(t.root, 'No reviews found on this page.');
  });

  it('shows the reload message when the content script is unreachable', async () => {
    const t = setup({ connect: vi.fn(() => { throw new Error('no receiver'); }) });
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    await waitFor(t.root, 'Reload the Taobao tab and try again.');
  });

  it('shows the reload message when the port drops before done', async () => {
    const t = setup();
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.drop();
    await waitFor(t.root, 'Reload the Taobao tab and try again.');
  });

  it('ignores onUpdated events for other tabs while an error is showing', async () => {
    const t = setup();
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.emit({ type: 'error', message: 'Could not read this page.' });
    await waitFor(t.root, 'Could not read this page.');
    t.changeTab(99);
    await new Promise(r => setTimeout(r, 20));
    expect(text(t.root)).toContain('Could not read this page.');
    expect(button(t.root, 'Retry')).toBeDefined();
  });

  it('shows content-script errors', async () => {
    const t = setup();
    await t.start();
    await vi.waitFor(() => button(t.root, 'Analyse this product').click());
    t.port.emit({ type: 'error', message: 'Could not read this page.' });
    await waitFor(t.root, 'Could not read this page.');
    expect(button(t.root, 'Retry')).toBeDefined();
  });

  it('keeps the cached fit override when re-analysing', async () => {
    const t = setup({}, { cached: cachedRun({ fitOverride: 'oversized' }) });
    await t.start();
    await vi.waitFor(() => button(t.root, 'Re-analyse').click());
    t.port.emit({ type: 'done', product, reviews, stoppedBy: 'exhausted' });
    await vi.waitFor(() => expect(t.deps.putCachedReport).toHaveBeenCalledOnce());
    expect(vi.mocked(t.deps.putCachedReport).mock.calls[0]![1].fitOverride).toBe('oversized');
  });

  it('fetches the exchange rate once per session, in parallel', async () => {
    const t = setup({ getCnyToCad: vi.fn(async () => ({ cnyToCad: 0.2, date: '2026-10-30', source: 'ecb' as const })) },
      { cached: cachedRun({ product: { ...product, price: { min: 100, max: 100 } } }) });
    await t.start();
    await waitFor(t.root, '¥100 ≈ CA$20.00');
    t.changeProfile(profile);
    await vi.waitFor(() => expect(t.deps.loadProfile).toHaveBeenCalledTimes(2));
    expect(t.deps.getCnyToCad).toHaveBeenCalledOnce();
  });
});

describe('re-rendering from the cache', () => {
  it('clicking Oversized re-renders with the override and makes no API calls', async () => {
    const t = setup({}, { cached: cachedRun() });
    await t.start();
    await waitFor(t.root, 'Chart says XL');
    t.root.querySelector<HTMLButtonElement>('.fit-select button[data-pref="oversized"]')!.click();
    await vi.waitFor(() =>
      expect(t.root.querySelector('.fit-select button[data-pref="oversized"]')!.getAttribute('aria-pressed')).toBe('true'));
    expect(t.deps.setFitOverride).toHaveBeenCalledWith('123', 'oversized');
    expect(text(t.root)).toContain('Chart says XXL');
    expect(t.deps.readSizeChart).not.toHaveBeenCalled();
    expect(t.deps.analyzeReviews).not.toHaveBeenCalled();
    expect(t.deps.connect).not.toHaveBeenCalled();
  });

  it('clicking the usual fit clears the override', async () => {
    const t = setup({}, { cached: cachedRun({ fitOverride: 'oversized' }) });
    await t.start();
    await waitFor(t.root, 'Chart says XXL');
    t.root.querySelector<HTMLButtonElement>('.fit-reset')!.click();
    await waitFor(t.root, 'Chart says XL');
    expect(t.deps.setFitOverride).toHaveBeenCalledWith('123', null);
  });

  it('re-renders when the profile changes, with no API call', async () => {
    const t = setup({}, { cached: cachedRun() });
    await t.start();
    await waitFor(t.root, 'Chart says XL');
    t.changeProfile({ ...profile, prefs: { ...profile.prefs, top: 'oversized' } });
    await waitFor(t.root, 'Chart says XXL');
    expect(t.deps.readSizeChart).not.toHaveBeenCalled();
    expect(t.deps.analyzeReviews).not.toHaveBeenCalled();
  });
});
