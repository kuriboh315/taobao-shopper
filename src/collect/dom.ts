import type { ProductData } from '../shared/types';
import { CAPTCHA_SELECTORS, CAPTCHA_URL } from './endpoints';
import { normalizeImageUrl, parseSalesCount } from './parse';

// ---- selectors and patterns ----------------------------------------------------

const TITLE_SELECTORS = ['[class*="mainTitle"]', '[class*="ItemTitle"]', 'h1'];
/** Site suffix of `document.title`, e.g. "-淘宝网" or "-tmall.com天猫". */
const TITLE_SUFFIX = /\s*[-–—_|]\s*(?:淘宝网|淘宝|tmall\.com天猫|天猫).*$/i;
const SALES_TEXT = /(?:已售|月销)\s*\d+(?:\.\d+)?\s*万?\+?/;
const DSR_PATTERNS = {
  description: /宝贝描述\s*[:：]?\s*(\d(?:\.\d+)?)/,
  service: /卖家服务\s*[:：]?\s*(\d(?:\.\d+)?)/,
  shipping: /物流服务\s*[:：]?\s*(\d(?:\.\d+)?)/,
} as const;
const DETAIL_IMAGE_SELECTORS = ['#description img', '.desc-root img', '[class*="descV8"] img', '[class*="desc-root"] img'];
/** Lazy-load attributes, most specific first. */
const IMAGE_ATTRS = ['data-src', 'data-ks-lazyload', 'src'];

// ---- extraction ----------------------------------------------------------------

function text(el: Element | null): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function titleFromDom(doc: Document): string | undefined {
  for (const sel of TITLE_SELECTORS) {
    const t = text(doc.querySelector(sel));
    if (t) return t;
  }
  const t = (doc.title ?? '').replace(TITLE_SUFFIX, '').trim();
  return t || undefined;
}

function detailImages(doc: Document): string[] {
  const out = new Set<string>();
  for (const img of doc.querySelectorAll(DETAIL_IMAGE_SELECTORS.join(','))) {
    for (const attr of IMAGE_ATTRS) {
      const u = normalizeImageUrl(img.getAttribute(attr) ?? '');
      if (u && !/\.gif$/i.test(u)) {
        out.add(u);
        break;
      }
    }
  }
  return [...out];
}

/** Product fields readable from the rendered page, used to fill what `parseProduct` left empty. */
export function productFromDom(doc: Document): Partial<ProductData> {
  const out: Partial<ProductData> = {};
  const title = titleFromDom(doc);
  if (title) out.title = title;

  const body = doc.body?.textContent ?? '';
  const sales = SALES_TEXT.exec(body)?.[0].replace(/\s+/g, ' ');
  if (sales) {
    out.salesText = sales;
    const n = parseSalesCount(sales);
    if (n !== undefined) out.salesCount = n;
  }

  const dsr: NonNullable<ProductData['shop']['dsr']> = {};
  for (const [key, re] of Object.entries(DSR_PATTERNS) as [keyof typeof DSR_PATTERNS, RegExp][]) {
    const m = re.exec(body);
    if (m) dsr[key] = Number(m[1]);
  }
  if (Object.keys(dsr).length > 0) out.shop = { dsr, extra: [] };

  const detail = detailImages(doc);
  if (detail.length > 0) out.images = { main: [], sku: [], detail };
  return out;
}

/** Fills empty fields of `product` from `dom`; values already present are kept. */
export function fillFromDom(product: ProductData, dom: Partial<ProductData>): ProductData {
  const out: ProductData = { ...product, shop: { ...product.shop }, images: { ...product.images } };
  if (!out.title && dom.title) out.title = dom.title;
  if (!out.salesText && dom.salesText) {
    out.salesText = dom.salesText;
    if (dom.salesCount !== undefined) out.salesCount = dom.salesCount;
  }
  if (!out.shop.dsr && dom.shop?.dsr) out.shop.dsr = dom.shop.dsr;
  if (!out.shop.name && dom.shop?.name) out.shop.name = dom.shop.name;
  for (const k of ['main', 'sku', 'detail'] as const) {
    if (out.images[k].length === 0 && dom.images?.[k].length) out.images[k] = dom.images[k];
  }
  return out;
}

// ---- review view (Taobao and Tmall share the same review components) -------------

/** One review in the inline preview or the "all reviews" drawer, e.g. `Comment--H5QmJwe9`. */
export const REVIEW_ITEM = '[class*="Comment--"]';
/**
 * Labels of the control that opens all reviews, most specific first. Matched against the whole (short) text of an
 * element, so a review that mentions 宝贝评价 never matches. The user's page may be machine-translated to English.
 */
const OPEN_REVIEW_LABELS = [/^(?:查看)?全部评价/, /^View all reviews/i, /^宝贝评价/, /^User Reviews/i];
const MAX_LABEL_LENGTH = 30;
const ANOMALY_TEXT = /检测到.*异常|detected an anomaly/i;
const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
/** Scroll step, as a share of the review list's visible height. */
const SCROLL_STEP = 0.8;
const POLL_MS = 250;
/** How long to wait for the drawer to appear after the click. */
const OPEN_WAIT_MS = 5000;
/** How long to wait for new reviews at the bottom of the list. */
const LOAD_WAIT_MS = 4000;

/** Waiting primitives; `stopped` ends a wait early (port disconnected or run finished). */
export interface Waiter {
  sleep(ms: number): Promise<void>;
  stopped(): boolean;
}

/** The "all reviews" drawer or modal, e.g. `Drawer--nzZd5HyY` in the Taobao and Tmall snapshots. */
const REVIEW_DRAWER = '[class*="Drawer--"], [class*="drawer"], [role="dialog"], dialog';
/** The review list inside it, e.g. `comments--ChxC7GEN`. */
const REVIEW_LIST_CLASS = /comments--/i;

/**
 * The element that scrolls the review list: inside the reviews drawer/modal only, the closest ancestor of a review
 * whose class looks like the review list (`comments--`), with `overflow-y: auto|scroll`, that is showing. Reviews in
 * the inline page preview never qualify, so a scrollable page layout wrapper is never chosen.
 */
export function findReviewScroller(doc: Document): HTMLElement | null {
  const view = doc.defaultView;
  if (!view) return null;
  const checked = new Set<Element>();
  for (const item of doc.querySelectorAll(REVIEW_ITEM)) {
    const drawer = item.closest(REVIEW_DRAWER);
    if (!drawer) continue;
    for (let el = item.parentElement; el && el !== drawer; el = el.parentElement) {
      if (checked.has(el)) break;
      checked.add(el);
      if (!REVIEW_LIST_CLASS.test(el.getAttribute('class') ?? '')) continue;
      const overflow = view.getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.clientHeight > 0) return el as HTMLElement;
    }
  }
  return null;
}

/** True when clicking `el` could follow a link: it is, or is inside, an `<a>` with a real href. */
function couldNavigate(el: Element): boolean {
  const a = el.closest('a[href]');
  if (!a) return false;
  const href = (a.getAttribute('href') ?? '').trim();
  return href !== '' && href !== '#' && !/^javascript:/i.test(href);
}

function normText(el: Element): string {
  return el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function labelMatches(el: Element, label: RegExp): boolean {
  const t = normText(el);
  return t.length <= MAX_LABEL_LENGTH && label.test(t) && !el.closest(REVIEW_ITEM);
}

/** Text nodes of the page body outside scripts and styles. */
function* textNodes(doc: Document): Generator<Text> {
  if (!doc.body) return;
  const SHOW_TEXT = 4;
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (parent && !NON_TEXT_TAGS.has(parent.tagName)) yield n as Text;
  }
}

/**
 * The innermost element whose text is the label, i.e. what a user would click. Controls that could navigate
 * (links with a real href) are never returned.
 */
function findOpenControl(doc: Document): HTMLElement | null {
  const holders: HTMLElement[] = [];
  for (const n of textNodes(doc)) {
    const v = n.nodeValue ?? '';
    const p = n.parentElement;
    if (p && 'click' in p && v.length <= MAX_LABEL_LENGTH && /\S/.test(v)) holders.push(p as HTMLElement);
  }
  for (const label of OPEN_REVIEW_LABELS) {
    const hit = holders.find((el) => labelMatches(el, label) && !couldNavigate(el));
    if (hit) return hit;
  }
  return null;
}

/**
 * Shows all reviews with at most one click: does nothing if a scrollable review list is already showing, else
 * clicks the "all reviews" control once and waits for the list. True when a scrollable list is showing.
 */
export async function openReviewsView(doc: Document, wait: Waiter): Promise<boolean> {
  if (findReviewScroller(doc)) return true;
  const control = findOpenControl(doc);
  if (!control) return false;
  control.click();
  for (let waited = 0; waited < OPEN_WAIT_MS; waited += POLL_MS) {
    if (findReviewScroller(doc)) return true;
    await wait.sleep(POLL_MS);
    if (wait.stopped()) return false;
  }
  return findReviewScroller(doc) !== null;
}

/**
 * Scrolls the review list (never the window) by 0.8x its visible height. True when it moved further down without
 * reaching the bottom, or when new reviews arrived within ~4 s; false at the bottom with nothing new.
 */
export async function scrollReviewsOnce(doc: Document, wait: Waiter & { count(): number }): Promise<boolean> {
  const el = findReviewScroller(doc);
  if (!el) return false;
  const reviewsBefore = wait.count();
  const itemsBefore = el.querySelectorAll(REVIEW_ITEM).length;
  const heightBefore = el.scrollHeight;
  const topBefore = el.scrollTop;
  el.scrollTop = topBefore + Math.max(1, Math.round(el.clientHeight * SCROLL_STEP));
  const moved = el.scrollTop > topBefore;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  if (moved && !atBottom) return true;
  const grew = () => wait.count() > reviewsBefore
    || el.querySelectorAll(REVIEW_ITEM).length > itemsBefore
    || el.scrollHeight > heightBefore;
  for (let waited = 0; waited < LOAD_WAIT_MS; waited += POLL_MS) {
    await wait.sleep(POLL_MS);
    if (wait.stopped()) return false;
    if (grew()) return true;
  }
  return false;
}

/**
 * Page text outside scripts and reviews, for the anomaly notice. One line per text node, so `.*` in the pattern
 * can't join words from unrelated parts of the page.
 */
function noticeText(doc: Document): string {
  const lines: string[] = [];
  for (const n of textNodes(doc)) {
    if (!n.parentElement?.closest(REVIEW_ITEM)) lines.push((n.nodeValue ?? '').replace(/\s+/g, ' '));
  }
  return lines.join('\n');
}

/** True when the page shows a captcha, a verification page or Taobao's "anomaly detected" notice. */
export function captchaVisible(doc: Document, href = doc.location?.href ?? ''): boolean {
  if (CAPTCHA_URL.test(href)) return true;
  if (doc.querySelector(CAPTCHA_SELECTORS.join(','))) return true;
  return ANOMALY_TEXT.test(noticeText(doc));
}
