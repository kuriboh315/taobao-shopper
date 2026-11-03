import { analyzeReviews } from '../ai/reviews';
import { readSizeChart } from '../ai/chart';
import {
  getCachedReport, loadProfile, loadSettings, putCachedReport, setFitOverride, type CachedRun,
} from '../profile/storage';
import { buildReport } from '../report/build';
import { getCnyToCad } from '../shared/fx';
import { PORT_NAME } from '../shared/messages';
import type { FitPref, FxRate, Profile, Settings } from '../shared/types';
import { renderReport, renderState, type PanelState } from './render';
import { RunRegistry, type PanelPort, type RunDeps } from './runs';

export type { PanelPort } from './runs';

export interface PanelDeps extends RunDeps {
  getActiveTab(): Promise<{ id?: number; url?: string } | undefined>;
  openOptions(): void;
  /** Called when the active tab changes or navigates. */
  onTabChange(cb: (updatedTabId?: number) => void): void;
  /** Called when any tab closes, so its run can be dropped. */
  onTabRemoved(cb: (tabId: number) => void): void;
  /** Called with the changed storage keys. */
  onStorageChange(cb: (keys: string[]) => void): void;
  loadProfile: typeof loadProfile;
  loadSettings: typeof loadSettings;
  setFitOverride: typeof setFitOverride;
  getCnyToCad: typeof getCnyToCad;
  buildReport: typeof buildReport;
}

export interface PanelController {
  /** Re-reads the active tab and shows the right state. Resolves when the first render is done. */
  refresh(): Promise<void>;
}

const PRODUCT_HOSTS = new Set(['item.taobao.com', 'detail.tmall.com']);

/** Returns the item id when the URL is a Taobao or Tmall product page, else null. */
export function itemIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!PRODUCT_HOSTS.has(u.hostname) || u.pathname !== '/item.htm') return null;
    return u.searchParams.get('id') || null;
  } catch {
    return null;
  }
}

export function createPanel(root: HTMLElement, deps: PanelDeps): PanelController {
  /** The tab whose state is on screen. Analyses run for every tab, not just this one. */
  let viewing: { tabId: number; itemId: string } | null = null;
  let settings: Settings | null = null;
  let viewToken = 0; // bumped whenever the view changes; stale async renders check it
  let showingReport = false;
  let fxPromise: Promise<FxRate | null> | null = null;

  const runs = new RunRegistry(deps, (tabId) => {
    if (viewing?.tabId === tabId) void showCurrent();
  });

  const state = (s: PanelState) => {
    showingReport = false;
    renderState(root, s, {
      onSettings: () => deps.openOptions(),
      onAnalyse: () => analyse(),
      onRetry: () => analyse(),
      onResume: () => { if (viewing) runs.resume(viewing.tabId); },
      onFinish: () => { if (viewing) runs.finishCollection(viewing.tabId); },
    });
  };

  const fx = (): Promise<FxRate | null> => {
    fxPromise ??= deps.getCnyToCad(settings).catch(() => null);
    return fxPromise;
  };

  async function showReport(run: CachedRun, myToken: number): Promise<void> {
    const [profile, rate] = await Promise.all([deps.loadProfile(), fx()]);
    if (myToken !== viewToken) return;
    const report = deps.buildReport(run, profile as Profile, rate);
    renderReport(root, report, {
      at: run.at,
      now: deps.now(),
      handlers: {
        onFit: (pref) => void changeFit(pref),
        onReanalyse: () => analyse(),
        onSettings: () => deps.openOptions(),
      },
    });
    showingReport = true;
  }

  /** Shows what the viewed tab should show: its run if it has one, else its cached report, else idle. */
  async function showCurrent(): Promise<void> {
    if (!viewing) return state({ kind: 'not_taobao' });
    if (!settings) return state({ kind: 'no_settings' });
    const run = runs.get(viewing.tabId);
    if (run) return state(run.state);
    const myToken = ++viewToken;
    const cached = await deps.getCachedReport(viewing.itemId);
    if (myToken !== viewToken) return;
    if (cached) await showReport(cached, myToken);
    else state({ kind: 'idle' });
  }

  async function rerender(): Promise<void> {
    if (!viewing || runs.get(viewing.tabId)) return;
    const myToken = viewToken;
    const run = await deps.getCachedReport(viewing.itemId);
    if (run && myToken === viewToken) await showReport(run, myToken);
  }

  async function changeFit(pref: FitPref | null): Promise<void> {
    if (!viewing) return;
    await deps.setFitOverride(viewing.itemId, pref);
    await rerender();
  }

  async function refresh(force: boolean, updatedTabId?: number): Promise<void> {
    const tab = await deps.getActiveTab();
    // onUpdated fires for every tab; only the active tab matters here.
    if (updatedTabId !== undefined && updatedTabId !== tab?.id) return;
    const itemId = itemIdFromUrl(tab?.url);
    if (tab?.id === undefined || !itemId) {
      viewToken++;
      viewing = null;
      return state({ kind: 'not_taobao' });
    }
    // A tab that moved to another product has a run that no longer describes it.
    const existing = runs.get(tab.id);
    if (existing && existing.itemId !== itemId) runs.stop(tab.id);

    // Tab events fire during collection too; don't disturb the view they are already looking at.
    const unchanged = viewing?.tabId === tab.id && viewing.itemId === itemId;
    if (!force && unchanged && (showingReport || runs.get(tab.id) !== undefined)) return;

    const myToken = ++viewToken;
    viewing = { tabId: tab.id, itemId };
    if (force) fxPromise = null;

    settings = await deps.loadSettings();
    if (myToken !== viewToken) return;
    if (!settings) return state({ kind: 'no_settings' });
    void fx(); // start the rate lookup now, in parallel with the cache read
    await showCurrent();
  }

  function analyse(): void {
    if (!viewing || !settings) return;
    runs.start(viewing.tabId, viewing.itemId, settings);
  }

  deps.onTabChange((updatedTabId) => void refresh(false, updatedTabId));
  deps.onTabRemoved((tabId) => runs.stop(tabId));
  deps.onStorageChange((keys) => {
    if (keys.includes('profile')) void rerender();
    const viewedRun = viewing ? runs.get(viewing.tabId) : undefined;
    if (keys.includes('settings') && !viewedRun && !showingReport) void refresh(true);
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
    onTabRemoved: (cb) => chrome.tabs.onRemoved.addListener((id) => cb(id)),
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
