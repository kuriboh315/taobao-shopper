import { analyzeReviews } from '../ai/reviews';
import { readSizeChart } from '../ai/chart';
import {
  getCachedReport, loadProfile, loadSettings, putCachedReport, setFitOverride, type CachedRun,
} from '../profile/storage';
import { buildReport } from '../report/build';
import { getCnyToCad } from '../shared/fx';
import {
  PORT_NAME, parseContentMessage, type ContentToPanel, type PanelToContent,
} from '../shared/messages';
import type { FitPref, FxRate, Profile, Settings } from '../shared/types';
import { renderReport, renderState, type PanelState } from './render';

export interface PanelPort {
  postMessage(m: PanelToContent): void;
  disconnect(): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface PanelDeps {
  getActiveTab(): Promise<{ id?: number; url?: string } | undefined>;
  connect(tabId: number): PanelPort;
  openOptions(): void;
  /** Called when the active tab changes or navigates. */
  onTabChange(cb: (updatedTabId?: number) => void): void;
  /** Called with the changed storage keys. */
  onStorageChange(cb: (keys: string[]) => void): void;
  loadProfile: typeof loadProfile;
  loadSettings: typeof loadSettings;
  getCachedReport: typeof getCachedReport;
  putCachedReport: typeof putCachedReport;
  setFitOverride: typeof setFitOverride;
  readSizeChart: typeof readSizeChart;
  analyzeReviews: typeof analyzeReviews;
  getCnyToCad: typeof getCnyToCad;
  buildReport: typeof buildReport;
  now: () => number;
}

export interface PanelController {
  /** Re-reads the active tab and shows the right state. Resolves when the first render is done. */
  refresh(): Promise<void>;
}

const RELOAD_MSG = 'Reload the Taobao tab and try again.';
const GENERIC_ERROR = 'Something went wrong. Try again.';

/** Returns the item id when the URL is a Taobao product page, else null. */
export function itemIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== 'item.taobao.com' || u.pathname !== '/item.htm') return null;
    return u.searchParams.get('id') || null;
  } catch {
    return null;
  }
}

export function createPanel(root: HTMLElement, deps: PanelDeps): PanelController {
  let target: { tabId: number; itemId: string; url: string } | null = null;
  let settings: Settings | null = null;
  let token = 0; // bumped whenever the target changes or a new analysis starts; stale async work checks it
  let busy = false; // an analysis is running
  let showingReport = false;
  let port: PanelPort | null = null;
  let fxPromise: Promise<FxRate | null> | null = null;

  const state = (s: PanelState) => {
    showingReport = false;
    renderState(root, s, {
      onSettings: () => deps.openOptions(),
      onAnalyse: () => void analyse(),
      onRetry: () => void analyse(),
      onResume: () => port?.postMessage({ type: 'resume' }),
      onFinish: () => port?.postMessage({ type: 'finish' }),
    });
  };

  const closePort = () => {
    const p = port;
    port = null;
    try { p?.disconnect(); } catch { /* already closed */ }
  };

  const fx = (): Promise<FxRate | null> => {
    fxPromise ??= deps.getCnyToCad(settings).catch(() => null);
    return fxPromise;
  };

  async function showReport(run: CachedRun, myToken: number): Promise<void> {
    const [profile, rate] = await Promise.all([deps.loadProfile(), fx()]);
    if (myToken !== token) return;
    const report = deps.buildReport(run, profile as Profile, rate);
    renderReport(root, report, {
      at: run.at,
      now: deps.now(),
      handlers: { onFit: (pref) => void changeFit(pref), onReanalyse: () => void analyse() },
    });
    showingReport = true;
  }

  async function rerender(): Promise<void> {
    if (!target || busy) return;
    const myToken = token;
    const run = await deps.getCachedReport(target.itemId);
    if (run && myToken === token) await showReport(run, myToken);
  }

  async function changeFit(pref: FitPref | null): Promise<void> {
    if (!target) return;
    await deps.setFitOverride(target.itemId, pref);
    await rerender();
  }

  async function refresh(force = true, updatedTabId?: number): Promise<void> {
    const tab = await deps.getActiveTab();
    // onUpdated fires for every tab; only the active tab matters here.
    if (updatedTabId !== undefined && updatedTabId !== tab?.id) return;
    const itemId = itemIdFromUrl(tab?.url);
    if (tab?.id === undefined || !tab.url || !itemId) {
      token++;
      busy = false;
      target = null;
      closePort();
      state({ kind: 'not_taobao' });
      return;
    }
    // Tab events fire during collection too; keep the running analysis if the target is unchanged.
    if (!force && target && target.tabId === tab.id && target.url === tab.url && (busy || showingReport)) return;

    const myToken = ++token;
    busy = false;
    closePort();
    target = { tabId: tab.id, itemId, url: tab.url };
    fxPromise = null;

    settings = await deps.loadSettings();
    if (myToken !== token) return;
    if (!settings) return state({ kind: 'no_settings' });
    void fx(); // start the rate lookup now, in parallel with the cache read
    const cached = await deps.getCachedReport(itemId);
    if (myToken !== token) return;
    if (cached) await showReport(cached, myToken);
    else state({ kind: 'idle' });
  }

  async function analyse(): Promise<void> {
    if (!target || !settings) return;
    const { tabId, itemId } = target;
    const myToken = ++token;
    closePort();
    busy = true;
    let reviewCount = 0;
    let collected = false;
    const fail = (msg: string) => {
      if (myToken !== token) return;
      busy = false;
      closePort();
      state({ kind: 'error', msg });
    };

    state({ kind: 'progress', msg: 'Reading reviews (0 so far)…' });
    let p: PanelPort;
    try {
      p = deps.connect(tabId);
    } catch {
      return fail(RELOAD_MSG);
    }
    port = p;
    p.onDisconnect.addListener(() => {
      if (myToken === token && !collected) fail(RELOAD_MSG);
    });
    p.onMessage.addListener((raw) => {
      if (myToken !== token) return;
      const m: ContentToPanel | null = parseContentMessage(raw);
      if (!m) return;
      if (m.type === 'progress') {
        reviewCount = m.reviews;
        state({ kind: 'progress', msg: `Reading reviews (${m.reviews} so far)…` });
      } else if (m.type === 'captcha') {
        state({ kind: 'captcha' });
      } else if (m.type === 'error') {
        fail(m.message);
      } else if (!collected) {
        collected = true;
        void finishAnalysis(m, myToken, itemId);
      }
    });
    state({ kind: 'progress', msg: `Reading reviews (${reviewCount} so far)…` });
    p.postMessage({ type: 'collect' });
  }

  async function finishAnalysis(
    done: Extract<ContentToPanel, { type: 'done' }>, myToken: number, itemId: string,
  ): Promise<void> {
    closePort();
    if (!settings) return;
    const { product, reviews } = done;
    let chartMsg = 'Reading size chart…';
    let reviewsMsg: string | null = reviews.length > 0 ? 'Analysing reviews…' : null;
    const show = () => {
      if (myToken === token) state({ kind: 'progress', msg: [chartMsg, reviewsMsg].filter(Boolean).join('\n') });
    };
    show();
    try {
      const [chart, analysis] = await Promise.all([
        deps.readSizeChart(product, settings, (msg) => { chartMsg = msg; show(); }),
        deps.analyzeReviews(reviews, product, settings).then((a) => { reviewsMsg = null; show(); return a; }),
      ]);
      if (myToken !== token) return;
      const existing = await deps.getCachedReport(itemId);
      const run: CachedRun = { at: deps.now(), product, reviews, chart, analysis };
      if (existing?.fitOverride) run.fitOverride = existing.fitOverride;
      await deps.putCachedReport(itemId, run);
      if (myToken !== token) return;
      busy = false;
      await showReport(run, myToken);
    } catch (err) {
      if (myToken !== token) return;
      busy = false;
      state({ kind: 'error', msg: err instanceof Error && err.message ? err.message : GENERIC_ERROR });
    }
  }

  deps.onTabChange((updatedTabId) => void refresh(false, updatedTabId));
  deps.onStorageChange((keys) => {
    if (keys.includes('profile')) void rerender();
    if (keys.includes('settings') && !busy && !showingReport) void refresh(true);
  });

  return { refresh: () => refresh(true) };
}

// ---- real wiring -----------------------------------------------------------

function realDeps(): PanelDeps {
  return {
    getActiveTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
    connect: (tabId) => chrome.tabs.connect(tabId, { name: PORT_NAME }) as unknown as PanelPort,
    openOptions: () => void chrome.runtime.openOptionsPage(),
    onTabChange: (cb) => {
      chrome.tabs.onActivated.addListener(() => cb());
      chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.status === 'complete') cb(id); });
    },
    onStorageChange: (cb) => {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') cb(Object.keys(changes));
      });
    },
    loadProfile, loadSettings, getCachedReport, putCachedReport, setFitOverride,
    readSizeChart, analyzeReviews, getCnyToCad, buildReport,
    now: () => Date.now(),
  };
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.tabs) {
  const root = document.getElementById('root');
  if (root) void createPanel(root, realDeps()).refresh();
}
