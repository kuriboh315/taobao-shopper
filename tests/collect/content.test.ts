// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://item.taobao.com/item.htm?id=123" }
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { startContent, type ContentPort } from '../../src/collect/content';
import type { ContentToPanel } from '../../src/shared/messages';

const PER_PAGE = 20;
const CLIENT_H = 500;
const PAGE_H = 1000;

function reviewBody(page: number, n = PER_PAGE) {
  return {
    ret: ['SUCCESS::调用成功'],
    data: { rateList: Array.from({ length: n }, (_, i) => ({ id: `p${page}-${i}`, feedback: `评价 ${page}-${i}` })) },
  };
}

const SSR = { item: { title: '测试T恤 SSR', images: [] } };

function hook(data: unknown, source: unknown = window) {
  window.dispatchEvent(new MessageEvent('message', { data, source: source as Window | null }));
}
function hookMsg(kind: string, body: unknown) {
  hook({ source: 'tbs-hook', kind, url: 'https://h5api.m.taobao.com/x', body });
}

interface Page { clicks: number; served: number; scroller: HTMLElement | null; openDrawer(): void }

/**
 * A product page with an inline review preview and a "View all reviews" button that opens a drawer.
 * The drawer's list scrolls (jsdom has no layout, so heights are faked); reaching its bottom makes the
 * page fetch the next review page 1 s later, until `pages` pages have been served.
 */
function setupPage(pages = 10): Page {
  document.title = '测试T恤-淘宝网';
  document.body.innerHTML = `
    <h1 class="ItemHeader--mainTitle--a">测试T恤</h1>
    <div class="Comments--eCO">
      <div class="comments--Chx" style="overflow-y: hidden"><div class="Comment--H5Q">好</div></div>
      <div class="footer--g"><div class="ShowButton--f"><font>View all reviews</font></div></div>
    </div>`;
  const page: Page = {
    clicks: 0,
    served: 1,
    scroller: null,
    openDrawer() {
      const drawer = document.createElement('div');
      drawer.className = 'Drawer--nzZ';
      drawer.innerHTML = '<div class="Comments--eCO"><div class="comments--Chx" style="overflow-y: scroll"></div></div>';
      document.body.append(drawer);
      const el = drawer.querySelector<HTMLElement>('.comments--Chx')!;
      const addItems = () => {
        for (let i = 0; i < PER_PAGE; i++) {
          const c = document.createElement('div');
          c.className = 'Comment--H5Q';
          c.textContent = `评价 ${page.served}-${i}`;
          el.append(c);
        }
      };
      addItems();
      let top = 0;
      let loading = false;
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => CLIENT_H });
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => CLIENT_H + PAGE_H * page.served });
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (v: number) => {
          top = Math.max(0, Math.min(v, el.scrollHeight - CLIENT_H));
          if (top >= el.scrollHeight - CLIENT_H && page.served < pages && !loading) {
            loading = true;
            setTimeout(() => {
              loading = false;
              page.served++;
              hookMsg('reviews', reviewBody(page.served));
              addItems();
            }, 1000);
          }
        },
      });
      page.scroller = el;
    },
  };
  document.querySelector('.ShowButton--f')!.addEventListener('click', () => {
    page.clicks++;
    page.openDrawer();
  });
  return page;
}

function makePort() {
  const sent: ContentToPanel[] = [];
  const onMsg: ((m: unknown) => void)[] = [];
  const onDisc: (() => void)[] = [];
  const port: ContentPort = {
    name: 'tbs',
    postMessage: (m) => { sent.push(m); },
    onMessage: { addListener: (cb) => { onMsg.push(cb); } },
    onDisconnect: { addListener: (cb) => { onDisc.push(cb); } },
  };
  return { port, sent, send: (m: unknown) => onMsg.forEach((cb) => cb(m)), disconnect: () => onDisc.forEach((cb) => cb()) };
}

let connect: (p: ContentPort) => void = () => {};

function start(): void {
  startContent({ win: window, onConnect: (cb) => { connect = cb; }, random: () => 0 });
}

async function runUntil(pred: () => boolean, maxMs = 200_000): Promise<void> {
  for (let t = 0; t < maxMs && !pred(); t += 250) await vi.advanceTimersByTimeAsync(250);
}

const doneOf = (sent: ContentToPanel[]) => sent.find((m) => m.type === 'done') as Extract<ContentToPanel, { type: 'done' }> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('content script', () => {
  it('asks the hook to replay on start and does nothing else until collect', async () => {
    const post = vi.spyOn(window, 'postMessage');
    const page = setupPage();
    start();
    expect(post).toHaveBeenCalledWith({ source: 'tbs-content', type: 'replay' }, window.location.origin);
    connect(makePort().port);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.clicks).toBe(0);
    expect(page.scroller).toBeNull();
  });

  it('opens the drawer once, scrolls its own container, and posts done at the cap', async () => {
    const page = setupPage();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await runUntil(() => !!doneOf(p.sent));

    const done = doneOf(p.sent)!;
    expect(done.stoppedBy).toBe('cap');
    expect(done.reviews).toHaveLength(80);
    expect(new Set(done.reviews.map((r) => r.id)).size).toBe(80);
    expect(done.product.itemId).toBe('123');
    expect(done.product.title).toBe('测试T恤 SSR');
    expect(page.clicks).toBe(1);
    expect(page.scroller!.scrollTop).toBeGreaterThan(0);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    const progress = p.sent.filter((m) => m.type === 'progress').map((m) => (m as { reviews: number }).reviews);
    expect(progress[0]).toBe(20);
    expect(progress.at(-1)).toBeGreaterThanOrEqual(80);
  });

  it('does not click when the drawer is already open, including on a second collect', async () => {
    const page = setupPage();
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    const p1 = makePort();
    connect(p1.port);
    p1.send({ type: 'collect' });
    await runUntil(() => !!doneOf(p1.sent));
    expect(page.clicks).toBe(1);
    p1.disconnect();

    const p2 = makePort();
    connect(p2.port);
    p2.send({ type: 'collect' });
    await runUntil(() => !!doneOf(p2.sent));
    expect(page.clicks).toBe(1);
    expect(doneOf(p2.sent)!.stoppedBy).toBe('cap');
  });

  it("stops with 'exhausted' when the drawer has nothing more", async () => {
    setupPage(2);
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await runUntil(() => !!doneOf(p.sent));
    const done = doneOf(p.sent)!;
    expect(done.stoppedBy).toBe('exhausted');
    expect(done.reviews).toHaveLength(40);
  });

  it('stops immediately when the port disconnects: no more scrolls, timers or messages', async () => {
    const page = setupPage();
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await runUntil(() => (page.scroller?.scrollTop ?? 0) > 0);
    const top = page.scroller!.scrollTop;
    const sentBefore = p.sent.length;
    p.disconnect();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(page.scroller!.scrollTop).toBe(top);
    expect(p.sent.length).toBe(sentBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats the anomaly notice as a captcha, pauses, and continues on resume', async () => {
    const page = setupPage();
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await runUntil(() => (page.scroller?.scrollTop ?? 0) > 0);

    const notice = document.createElement('div');
    notice.innerHTML = 'We have <b>detected an anomaly</b> in your traffic';
    document.body.append(notice);
    await runUntil(() => p.sent.some((m) => m.type === 'captcha'));
    const top = page.scroller!.scrollTop;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.scroller!.scrollTop).toBe(top);
    expect(p.sent.filter((m) => m.type === 'captcha')).toHaveLength(1);
    expect(doneOf(p.sent)).toBeUndefined();

    notice.remove();
    p.send({ type: 'resume' });
    await runUntil(() => page.scroller!.scrollTop !== top);
    expect(page.scroller!.scrollTop).not.toBe(top);
    p.send({ type: 'finish' });
    await runUntil(() => !!doneOf(p.sent));
    expect(doneOf(p.sent)!.stoppedBy).toBe('user');
  });

  it('detects the Chinese anomaly notice and finishes with what it has on finish', async () => {
    setupPage();
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    document.body.insertAdjacentHTML('beforeend', '<div>系统检测到您的访问异常</div>');
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.sent).toContainEqual({ type: 'captcha' });
    p.send({ type: 'finish' });
    await runUntil(() => !!doneOf(p.sent));
    const done = doneOf(p.sent)!;
    expect(done.stoppedBy).toBe('user');
    expect(done.reviews).toHaveLength(20);
  });

  it('ignores the anomaly phrase inside a review', async () => {
    const page = setupPage();
    document.querySelector('.Comment--H5Q')!.textContent = '卖家说系统检测到异常，发货慢';
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await runUntil(() => (page.scroller?.scrollTop ?? 0) > 0);
    expect(p.sent).not.toContainEqual({ type: 'captcha' });
  });

  it('treats a captcha response body as a captcha', async () => {
    const page = setupPage();
    start();
    hookMsg('product', SSR);
    hookMsg('reviews', reviewBody(1));
    hookMsg('reviews', { ret: ['FAIL_SYS_USER_VALIDATE::哎哟喂,被挤爆啦'], data: { url: 'https://x/_____tmd_____/punish?x=1' } });
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.sent).toContainEqual({ type: 'captcha' });
    expect(page.clicks).toBe(0);
  });

  it('treats a captcha element as a captcha', async () => {
    const page = setupPage();
    document.body.insertAdjacentHTML('beforeend', '<div id="baxia-dialog-content"></div>');
    start();
    hookMsg('product', SSR);
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.sent).toEqual([{ type: 'captcha' }]);
    expect(page.clicks).toBe(0);
  });

  it('rejects messages from other sources or with a bad shape', async () => {
    setupPage(1);
    start();
    hookMsg('product', SSR);
    hook({ source: 'tbs-hook', kind: 'reviews', url: 'x', body: reviewBody(7) }, null);
    hook({ source: 'tbs-hook', kind: 'reviews', url: 'x', body: reviewBody(8) }, {});
    hook({ source: 'evil', kind: 'reviews', url: 'x', body: reviewBody(9) });
    hook({ source: 'tbs-hook', kind: 'script', url: 'x', body: reviewBody(10) });
    hook({ source: 'tbs-hook', kind: 'reviews', url: 42, body: reviewBody(11) });
    hook('tbs-hook');
    hook(null);
    hookMsg('reviews', reviewBody(1, 3));
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await runUntil(() => !!doneOf(p.sent));
    expect(doneOf(p.sent)!.reviews.map((r) => r.id)).toEqual(['p1-0', 'p1-1', 'p1-2']);
  });

  it('ignores unknown panel messages and ports with another name', async () => {
    const page = setupPage();
    start();
    hookMsg('product', SSR);
    const other = makePort();
    other.port.name = 'other';
    connect(other.port);
    other.send({ type: 'collect' });
    const p = makePort();
    connect(p.port);
    p.send({ type: 'go' });
    p.send('collect');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.clicks).toBe(0);
    expect(other.sent).toEqual([]);
    expect(p.sent).toEqual([]);
  });

  it('posts an error when there is no product data and no title', async () => {
    document.title = '';
    document.body.innerHTML = '<div>nothing here</div>';
    start();
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.sent).toEqual([{
      type: 'error',
      message: "Couldn't read this page. Make sure you're logged in to Taobao and the product page has fully loaded.",
    }]);
  });

  it('falls back to the DOM title when there is no product data', async () => {
    setupPage(1);
    start();
    const p = makePort();
    connect(p.port);
    p.send({ type: 'collect' });
    await runUntil(() => !!doneOf(p.sent));
    expect(doneOf(p.sent)!.product.title).toBe('测试T恤');
  });
});
