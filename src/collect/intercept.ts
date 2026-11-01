import { API_PATTERNS, CONTENT_SOURCE, HOOK_SOURCE, type HookKind, type HookMessage } from './endpoints';

/** Path of the server-rendered product data on the page window. */
const SSR_PATH = ['__ICE_APP_CONTEXT__', 'loaderData', 'home', 'data', 'res'] as const;
/** Replay buffer size; a run sees one product body plus a few dozen review pages. */
const REPLAY_CAP = 200;
const JSONP_RE = /^\s*[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/;
const CALLBACK_NAME = /^[\w$]+$/;

/** The parts of `window` the hook touches; a plain object in tests. */
export interface HookWindow {
  document: Document;
  location: { href: string; origin: string };
  MutationObserver: typeof MutationObserver;
  addEventListener(type: string, cb: (e: { source?: unknown; data?: unknown }) => void): void;
  postMessage?(message: unknown, targetOrigin: string): void;
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
}

type AnyFn = (...args: unknown[]) => unknown;

/** `window.__ICE_APP_CONTEXT__.loaderData.home.data.res`, or undefined. */
export function extractSsr(win: unknown): unknown {
  let cur: unknown = win;
  for (const key of SSR_PATH) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur ?? undefined;
}

/** Parses a JSON or JSONP (`cb({...})`) body; undefined when it isn't JSON. */
export function stripJsonp(text: string): unknown {
  const m = JSONP_RE.exec(text);
  try {
    return JSON.parse(m ? m[1]! : text);
  } catch {
    return undefined;
  }
}

/** Which API a URL belongs to, or null if the hook ignores it. */
export function classifyUrl(url: string): Exclude<HookKind, 'product'> | null {
  for (const kind of ['reviews', 'desc'] as const) {
    if (API_PATTERNS[kind].some((re) => re.test(url))) return kind;
  }
  return null;
}

function callbackName(src: string): string | null {
  try {
    const name = new URL(src, 'https://invalid.example/').searchParams.get('callback');
    return name && CALLBACK_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    if ('url' in input && typeof input.url === 'string') return input.url;
    if ('href' in input && typeof input.href === 'string') return input.href;
  }
  return String(input);
}

/**
 * Observes the page's product data and review/description responses (fetch, XHR and JSONP) and posts copies.
 * It never changes, blocks or issues requests: every wrapper calls the original and returns its result.
 */
export function installHook(win: HookWindow, post?: (m: HookMessage) => void): void {
  const send = post ?? ((m: HookMessage) => win.postMessage?.(m, win.location.origin));
  const seen: HookMessage[] = [];

  const emit = (kind: HookKind, url: string, body: unknown) => {
    if (body === undefined) return;
    const msg: HookMessage = { source: HOOK_SOURCE, kind, url, body };
    seen.push(msg);
    if (seen.length > REPLAY_CAP) seen.splice(1, 1); // keep the first (usually the product) message
    try { send(msg); } catch { /* uncloneable body: drop it */ }
  };

  // ---- server-rendered product data ----
  let productSent = false;
  const readSsr = () => {
    if (productSent) return;
    const res = extractSsr(win);
    if (res === undefined) return;
    productSent = true;
    emit('product', win.location.href, res);
  };
  if (win.document.readyState !== 'loading') readSsr();
  win.addEventListener('DOMContentLoaded', readSsr);
  win.addEventListener('load', readSsr);

  // The content script starts after the page has loaded, so it asks for everything seen so far.
  win.addEventListener('message', (e) => {
    if (e.source !== win) return;
    const d = e.data as { source?: unknown; type?: unknown } | null;
    if (!d || d.source !== CONTENT_SOURCE || d.type !== 'replay') return;
    readSsr();
    for (const m of seen) {
      try { send(m); } catch { /* ignore */ }
    }
  });

  // ---- fetch ----
  const origFetch = win.fetch;
  if (typeof origFetch === 'function') {
    win.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const p = origFetch.apply(this, args);
      try {
        const reqUrl = urlOf(args[0]);
        p.then((res) => {
          const url = res.url || reqUrl;
          const kind = classifyUrl(url);
          if (kind) return res.clone().text().then((t) => emit(kind, url, stripJsonp(t)));
        }).catch(() => { /* the page handles its own errors */ });
      } catch { /* never break the page's fetch */ }
      return p;
    } as typeof fetch;
  }

  // ---- XHR ----
  const Xhr = win.XMLHttpRequest;
  if (typeof Xhr === 'function') {
    const proto = Xhr.prototype;
    const origOpen = proto.open as unknown as AnyFn;
    const origSend = proto.send as unknown as AnyFn;
    const urls = new WeakMap<object, string>();
    proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      try { urls.set(this, urlOf(args[1])); } catch { /* ignore */ }
      return origOpen.apply(this, args);
    } as typeof proto.open;
    proto.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      const url = urls.get(this);
      const kind = url ? classifyUrl(url) : null;
      if (url && kind) {
        this.addEventListener('load', () => {
          try {
            const type = this.responseType;
            const body = type === 'json' ? this.response : type === '' || type === 'text' ? stripJsonp(this.responseText) : undefined;
            emit(kind, url, body);
          } catch { /* ignore */ }
        });
      }
      return origSend.apply(this, args);
    } as typeof proto.send;
  }

  // ---- JSONP: wrap window[callback] before the inserted <script> runs ----
  const target = win as unknown as Record<string, unknown>;
  const wrappers = new WeakSet<AnyFn>();
  const wrap = (fn: AnyFn, kind: HookKind, url: string): AnyFn => {
    if (wrappers.has(fn)) return fn;
    const w = function (this: unknown, ...args: unknown[]) {
      try { emit(kind, url, args[0]); } catch { /* ignore */ }
      return fn.apply(this, args);
    };
    wrappers.add(w);
    return w;
  };
  const hookCallback = (name: string, kind: HookKind, url: string) => {
    const cur = target[name];
    if (typeof cur === 'function') {
      target[name] = wrap(cur as AnyFn, kind, url);
      return;
    }
    // Not assigned yet: wrap whatever the page assigns.
    let value: unknown = cur;
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (v: unknown) => { value = typeof v === 'function' ? wrap(v as AnyFn, kind, url) : v; },
      });
    } catch { /* non-configurable: leave it alone */ }
  };
  const onNode = (node: Node) => {
    if (node.nodeName !== 'SCRIPT') return;
    const src = (node as HTMLScriptElement).src;
    if (!src) return;
    const kind = classifyUrl(src);
    const name = kind ? callbackName(src) : null;
    if (kind && name) hookCallback(name, kind, src);
  };
  new win.MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(onNode);
  }).observe(win.document, { childList: true, subtree: true });
}
