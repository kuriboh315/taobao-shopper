import type { ProductData } from '../shared/types';
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
