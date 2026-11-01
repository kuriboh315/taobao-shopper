// Isolated-world content script: buffers what the MAIN-world hook observed, and runs one careful review
// collection when the side panel asks for it over the "tbs" port. Nothing happens on page load.
// Built as a self-contained IIFE (vite.content.config.ts) because content scripts can't use ES imports.
import { z } from 'zod';
import { PORT_NAME, type ContentToPanel, type PanelToContent, type StopReason } from '../shared/messages';
import type { ProductData, Review } from '../shared/types';
import { captchaVisible, fillFromDom, openReviewsView, productFromDom, scrollReviewsOnce } from './dom';
import { REVIEW_CAP, ReviewDriver } from './driver';
import { CONTENT_SOURCE, HOOK_SOURCE } from './endpoints';
import { isCaptchaResponse, parseDescImages, parseProduct, parseReviews } from './parse';

export const NO_PRODUCT_MSG =
  "Couldn't read this page. Make sure you're logged in to Taobao and the product page has fully loaded.";
/** Most bodies kept per kind; a run needs a few dozen review pages at most. */
const MAX_BODIES = 200;

/** The chrome.runtime.Port surface the content script uses; a plain object in tests. */
export interface ContentPort {
  name: string;
  postMessage(m: ContentToPanel): void;
  onMessage: { addListener(cb: (m: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface ContentEnv {
  win: Window;
  onConnect(cb: (port: ContentPort) => void): void;
  random?: () => number;
  now?: () => number;
}

/** Hook messages come through window.postMessage, which any page script can use: untrusted input. */
const HookMessage = z.object({
  source: z.literal(HOOK_SOURCE),
  kind: z.enum(['product', 'reviews', 'desc']),
  url: z.string().max(8192),
  body: z.unknown(),
});
const PanelMessage = z.object({ type: z.enum(['collect', 'resume', 'finish']) });

interface Run {
  driver: ReviewDriver;
  /** Ends every pending wait (sleep, drawer wait, load wait) at once. */
  abort: AbortController;
  /** The panel is gone: send nothing more. */
  dead: boolean;
}

function itemIdOf(href: string): string {
  try {
    return new URL(href).searchParams.get('id') ?? '';
  } catch {
    return '';
  }
}

export function startContent(env: ContentEnv): void {
  const { win } = env;
  const doc = win.document;
  const random = env.random ?? Math.random;
  const now = env.now ?? Date.now;

  let productBody: unknown;
  const reviewBodies: unknown[] = [];
  const descBodies: unknown[] = [];
  let captchaResponse = false;
  let current: Run | null = null;

  win.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== win) return;
    const r = HookMessage.safeParse(e.data);
    if (!r.success) return;
    const { kind, body } = r.data;
    if (isCaptchaResponse(body)) {
      captchaResponse = true;
      return;
    }
    if (kind === 'product') productBody ??= body;
    else {
      const list = kind === 'reviews' ? reviewBodies : descBodies;
      if (list.length < MAX_BODIES) list.push(body);
    }
  });
  // The hook started at document_start; ask it for everything it has seen so far.
  win.postMessage({ source: CONTENT_SOURCE, type: 'replay' }, win.location.origin);

  const reviews = (): Review[] => parseReviews(reviewBodies);

  /** Product from the page data plus DOM fallbacks, or null when the page has neither data nor a title. */
  const product = (): ProductData | null => {
    const p = fillFromDom(parseProduct(productBody, itemIdOf(win.location.href)), productFromDom(doc));
    if (productBody === undefined && !p.title) return null;
    if (p.images.detail.length === 0) p.images.detail = parseDescImages(descBodies);
    return p;
  };

  const stop = (run: Run, dead: boolean) => {
    if (dead) run.dead = true;
    run.driver.finish();
    run.abort.abort();
  };

  /** Starts a collection run that reports to `port`; any earlier run is stopped silently. */
  function startRun(port: ContentPort): { run: Run; finished: Promise<void> } {
    const abort = new AbortController();
    const { signal } = abort;
    const post = (m: ContentToPanel) => {
      if (run.dead) return;
      try { port.postMessage(m); } catch { run.dead = true; }
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done);
    });
    const waiter = { sleep, stopped: () => signal.aborted };
    const driver = new ReviewDriver({
      openReviews: () => openReviewsView(doc, waiter),
      loadMore: () => scrollReviewsOnce(doc, { ...waiter, count: () => reviews().length }),
      count: () => reviews().length,
      captchaVisible: () => captchaResponse || captchaVisible(doc, win.location.href),
      sleep,
      random,
      now,
      onProgress: (n) => post({ type: 'progress', reviews: n }),
      onCaptcha: () => post({ type: 'captcha' }),
    });
    const run: Run = { driver, abort, dead: false };

    if (current) stop(current, true);
    current = run;
    const execute = async () => {
      // Unreadable page: say so before touching anything.
      if (!product()) return post({ type: 'error', message: NO_PRODUCT_MSG });
      let stoppedBy: StopReason;
      try {
        stoppedBy = await run.driver.run();
      } finally {
        abort.abort(); // cancel anything still waiting
      }
      if (run.dead) return;
      const p = product();
      if (!p) return post({ type: 'error', message: NO_PRODUCT_MSG });
      post({ type: 'done', product: p, reviews: reviews().slice(0, REVIEW_CAP), stoppedBy });
    };
    const finished = execute()
      .catch(() => post({ type: 'error', message: 'Something went wrong. Try again.' }))
      .finally(() => { if (current === run) current = null; });
    return { run, finished };
  }

  env.onConnect((port) => {
    if (port.name !== PORT_NAME) return;
    let run: Run | null = null;
    let busy = false;
    port.onDisconnect.addListener(() => {
      if (run) stop(run, true);
    });
    port.onMessage.addListener((raw) => {
      const r = PanelMessage.safeParse(raw);
      if (!r.success) return;
      const m: PanelToContent = r.data;
      if (m.type === 'collect') {
        if (busy) return; // one run per port at a time
        busy = true;
        const started = startRun(port);
        run = started.run;
        void started.finished.then(() => { busy = false; });
      } else if (m.type === 'resume') {
        captchaResponse = false; // the user says it's solved; the DOM is checked again right away
        run?.driver.resume();
      } else if (run) {
        stop(run, false);
      }
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  startContent({
    win: window,
    onConnect: (cb) => chrome.runtime.onConnect.addListener((p) => cb(p as unknown as ContentPort)),
  });
}
