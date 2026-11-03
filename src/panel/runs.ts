import { mergeCharts, readSizeChart } from '../ai/chart';
import { analyzeReviews } from '../ai/reviews';
import { getCachedReport, putCachedReport, type CachedRun } from '../profile/storage';
import { parseContentMessage, type ContentToPanel, type PanelToContent } from '../shared/messages';
import type { Settings } from '../shared/types';

export const RELOAD_MSG = 'Reload the Taobao tab and try again.';
const GENERIC_ERROR = 'Something went wrong. Try again.';

export interface PanelPort {
  postMessage(m: PanelToContent): void;
  disconnect(): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

/** What a tab shows while its analysis is in flight, or after one failed. */
export type RunState =
  | { kind: 'progress'; msg: string }
  | { kind: 'captcha' }
  | { kind: 'error'; msg: string };

export interface RunDeps {
  connect(tabId: number): PanelPort;
  getCachedReport: typeof getCachedReport;
  putCachedReport: typeof putCachedReport;
  readSizeChart: typeof readSizeChart;
  analyzeReviews: typeof analyzeReviews;
  now: () => number;
}

interface Run {
  tabId: number;
  itemId: string;
  state: RunState;
  port: PanelPort | null;
  /** The reviews arrived, so a later port drop is expected rather than a failure. */
  collected: boolean;
}

const reviewsMsg = (n: number) => `Reading reviews (${n} so far)…`;

/**
 * One analysis per tab, all of them running at once. A run lives here rather than in whatever the panel
 * happens to be rendering, so switching tabs only changes the view; `onChange` asks the panel to re-render
 * a tab. Stale work is discarded by identity: a run that is no longer the map's entry for its tab is dead.
 */
export class RunRegistry {
  private readonly runs = new Map<number, Run>();

  constructor(private readonly deps: RunDeps, private readonly onChange: (tabId: number) => void) {}

  /** The run shown for a tab, a failed one included, or undefined when the tab has none. */
  get(tabId: number): { itemId: string; state: RunState } | undefined {
    return this.runs.get(tabId);
  }

  /** Starts an analysis for a tab, replacing any run it already had. */
  start(tabId: number, itemId: string, settings: Settings): void {
    this.stop(tabId);
    const run: Run = { tabId, itemId, state: { kind: 'progress', msg: reviewsMsg(0) }, port: null, collected: false };
    this.runs.set(tabId, run);

    let port: PanelPort;
    try {
      port = this.deps.connect(tabId);
    } catch {
      return this.setState(run, { kind: 'error', msg: RELOAD_MSG });
    }
    run.port = port;
    port.onDisconnect.addListener(() => {
      if (!run.collected) this.setState(run, { kind: 'error', msg: RELOAD_MSG });
    });
    port.onMessage.addListener((raw) => {
      if (!this.isCurrent(run)) return;
      const m: ContentToPanel | null = parseContentMessage(raw);
      if (!m) return;
      if (m.type === 'progress') this.setState(run, { kind: 'progress', msg: reviewsMsg(m.reviews) });
      else if (m.type === 'captcha') this.setState(run, { kind: 'captcha' });
      else if (m.type === 'error') this.setState(run, { kind: 'error', msg: m.message });
      else if (!run.collected) {
        run.collected = true;
        void this.analyse(run, m, settings);
      }
    });
    this.onChange(tabId);
    port.postMessage({ type: 'collect' });
  }

  /** The user solved a captcha on that tab. */
  resume(tabId: number): void {
    this.runs.get(tabId)?.port?.postMessage({ type: 'resume' });
  }

  /** Asks a tab to stop collecting and analyse what it already has. */
  finishCollection(tabId: number): void {
    this.runs.get(tabId)?.port?.postMessage({ type: 'finish' });
  }

  /** Drops a tab's run — it closed, moved to another product, or is being restarted. */
  stop(tabId: number): void {
    const run = this.runs.get(tabId);
    if (!run) return;
    this.runs.delete(tabId); // before closing the port, so pending work sees itself as dead
    this.closePort(run);
  }

  private isCurrent(run: Run): boolean {
    return this.runs.get(run.tabId) === run;
  }

  private setState(run: Run, state: RunState): void {
    if (!this.isCurrent(run)) return;
    run.state = state;
    this.onChange(run.tabId);
  }

  private closePort(run: Run): void {
    const p = run.port;
    run.port = null;
    try { p?.disconnect(); } catch { /* already closed */ }
  }

  /** Reads the size chart and the reviews, then caches the result for the item. */
  private async analyse(
    run: Run, done: Extract<ContentToPanel, { type: 'done' }>, settings: Settings,
  ): Promise<void> {
    this.closePort(run);
    const { product, reviews } = done;
    let chartMsg = 'Reading size chart…';
    let reviewsLine: string | null = reviews.length > 0 ? 'Analysing reviews…' : null;
    const show = () =>
      this.setState(run, { kind: 'progress', msg: [chartMsg, reviewsLine].filter(Boolean).join('\n') });
    show();
    try {
      // The photos are always read; the page's structured sizes only fill gaps or stand in when they have no chart.
      const [chart, analysis] = await Promise.all([
        this.deps.readSizeChart(product, settings, (msg) => { chartMsg = msg; show(); })
          .then((photo) => mergeCharts(photo, product.sizeChart)),
        this.deps.analyzeReviews(reviews, product, settings).then((a) => { reviewsLine = null; show(); return a; }),
      ]);
      if (!this.isCurrent(run)) return;
      const existing = await this.deps.getCachedReport(run.itemId);
      const cached: CachedRun = { at: this.deps.now(), product, reviews, chart, analysis };
      if (existing?.fitOverride) cached.fitOverride = existing.fitOverride;
      await this.deps.putCachedReport(run.itemId, cached);
      if (!this.isCurrent(run)) return;
      this.runs.delete(run.tabId); // done: the panel renders the cached report from here on
      this.onChange(run.tabId);
    } catch (err) {
      this.setState(run, { kind: 'error', msg: err instanceof Error && err.message ? err.message : GENERIC_ERROR });
    }
  }
}
