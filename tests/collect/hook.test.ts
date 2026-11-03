// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { classifyUrl, extractSsr, installHook, stripJsonp, type HookWindow } from '../../src/collect/intercept';
import { API_PATTERNS, CAPTCHA_URL, HOOK_SOURCE, type HookMessage } from '../../src/collect/endpoints';

const REVIEWS_URL = 'https://h5api.m.taobao.com/h5/mtop.taobao.rate.detaillist.get/6.0/?jsv=2.7.2&callback=mtopjsonp7&data=%7B%7D';
const DESC_URL = 'https://h5api.m.tmall.com/h5/mtop.taobao.detail.getdesc/7.0/?callback=mtopjsonp8';
const flush = () => new Promise(r => setTimeout(r, 0));

class FakeXhr {
  responseType = '';
  responseText = '';
  response: unknown = null;
  private listeners: (() => void)[] = [];
  open(_method: string, _url: string) { /* no network */ }
  send() { /* no network */ }
  addEventListener(_t: string, cb: () => void) { this.listeners.push(cb); }
  finish(text: string) { this.responseText = text; this.response = text; this.listeners.forEach(cb => cb()); }
}

function fakeWin(extra: Partial<HookWindow> = {}): HookWindow & Record<string, unknown> {
  const doc = document.implementation.createHTMLDocument('t');
  return {
    document: doc,
    location: { href: 'https://item.taobao.com/item.htm?id=1', origin: 'https://item.taobao.com' },
    MutationObserver,
    addEventListener: vi.fn(),
    ...extra,
  } as HookWindow & Record<string, unknown>;
}

describe('helpers', () => {
  it('extracts the SSR res', () => {
    const res = { item: { title: 'T' } };
    expect(extractSsr({ __ICE_APP_CONTEXT__: { loaderData: { home: { data: { res } } } } })).toBe(res);
    expect(extractSsr({})).toBeUndefined();
    expect(extractSsr({ __ICE_APP_CONTEXT__: 'x' })).toBeUndefined();
  });

  it('strips JSONP wrappers', () => {
    expect(stripJsonp('mtopjsonp3({"a":1})')).toEqual({ a: 1 });
    expect(stripJsonp(' mtopjsonp3( {"a":[1]} );\n')).toEqual({ a: [1] });
    expect(stripJsonp('{"b":2}')).toEqual({ b: 2 });
    expect(stripJsonp('not json')).toBeUndefined();
  });

  it('classifies API URLs', () => {
    expect(classifyUrl(REVIEWS_URL)).toBe('reviews');
    expect(classifyUrl(DESC_URL)).toBe('desc');
    expect(classifyUrl('https://example.com/a.js')).toBeNull();
    expect(API_PATTERNS.reviews.length).toBeGreaterThan(0);
    expect(CAPTCHA_URL.test('https://x.taobao.com//_____tmd_____/punish?x=1')).toBe(true);
  });
});

describe('installHook', () => {
  it('posts review bodies seen through fetch without changing the response', async () => {
    const post = vi.fn();
    const orig = vi.fn(async () => new Response('mtopjsonp1({"data":{"rateList":[]}})'));
    const win = fakeWin({ fetch: orig as unknown as typeof fetch });
    installHook(win, post);
    const res = await win.fetch!(REVIEWS_URL);
    expect(await res.text()).toBe('mtopjsonp1({"data":{"rateList":[]}})');
    await flush();
    expect(orig).toHaveBeenCalledWith(REVIEWS_URL);
    expect(post).toHaveBeenCalledWith({ source: HOOK_SOURCE, kind: 'reviews', url: REVIEWS_URL, body: { data: { rateList: [] } } });
  });

  it('ignores fetches to other URLs', async () => {
    const post = vi.fn();
    const win = fakeWin({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
    installHook(win, post);
    await win.fetch!('https://example.com/x');
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it('posts review bodies seen through XHR', () => {
    const post = vi.fn();
    const win = fakeWin({ XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest });
    installHook(win, post);
    const x = new (win.XMLHttpRequest as unknown as typeof FakeXhr)();
    x.open('GET', REVIEWS_URL);
    x.send();
    x.finish('mtopjsonp2({"ret":["SUCCESS::ok"]})');
    expect(post).toHaveBeenCalledWith({ source: HOOK_SOURCE, kind: 'reviews', url: REVIEWS_URL, body: { ret: ['SUCCESS::ok'] } });
  });

  it('wraps a JSONP callback defined before the script is inserted', async () => {
    const post = vi.fn();
    const win = fakeWin();
    installHook(win, post);
    const original = vi.fn();
    win.mtopjsonp7 = original;
    const s = win.document.createElement('script');
    s.src = REVIEWS_URL;
    win.document.head.appendChild(s);
    await flush();
    (win.mtopjsonp7 as (b: unknown) => void)({ data: { rateList: [{ id: '1' }] } });
    expect(original).toHaveBeenCalledWith({ data: { rateList: [{ id: '1' }] } });
    expect(post).toHaveBeenCalledWith({ source: HOOK_SOURCE, kind: 'reviews', url: REVIEWS_URL, body: { data: { rateList: [{ id: '1' }] } } });
  });

  it('wraps a JSONP callback assigned after the script is inserted', async () => {
    const post = vi.fn();
    const win = fakeWin();
    installHook(win, post);
    const s = win.document.createElement('script');
    s.src = DESC_URL;
    win.document.head.appendChild(s);
    await flush();
    const original = vi.fn(() => 'ret');
    win.mtopjsonp8 = original;
    expect((win.mtopjsonp8 as (b: unknown) => unknown)({ data: { x: 1 } })).toBe('ret');
    expect(original).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ source: HOOK_SOURCE, kind: 'desc', url: DESC_URL, body: { data: { x: 1 } } });
  });

  it('posts the SSR product data when the page is ready, and replays on request', () => {
    const post = vi.fn();
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const win = fakeWin({
      addEventListener: ((t: string, cb: (e: unknown) => void) => { (listeners[t] ??= []).push(cb); }) as HookWindow['addEventListener'],
    });
    installHook(win, post);
    const res = { item: { title: 'T' } };
    win.__ICE_APP_CONTEXT__ = { loaderData: { home: { data: { res } } } };
    listeners.DOMContentLoaded?.forEach(cb => cb({}));
    const product: HookMessage = { source: HOOK_SOURCE, kind: 'product', url: 'https://item.taobao.com/item.htm?id=1', body: res };
    expect(post).toHaveBeenCalledWith(product);

    post.mockClear();
    listeners.message?.forEach(cb => cb({ source: win, data: { source: 'tbs-content', type: 'replay' } }));
    expect(post).toHaveBeenCalledWith(product);
    listeners.message?.forEach(cb => cb({ source: {}, data: { source: 'tbs-content', type: 'replay' } }));
    expect(post).toHaveBeenCalledTimes(1);
  });
});
