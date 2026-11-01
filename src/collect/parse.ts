import { z } from 'zod';
import type { ProductData, Review } from '../shared/types';
import { CAPTCHA_RET_CODES, CAPTCHA_URL } from './endpoints';
import { structuredSizeChart, type SizeValue } from './parse-sizes';

// ---- constants ---------------------------------------------------------------
// Paths are relative to the SSR `res` (`__ICE_APP_CONTEXT__.loaderData.home.data.res`):
//   item.{title,vagueSellCount,images}, seller.{shopName,evaluates}, skuBase.props[].values[],
//   skuCore.sku2info.*.{price,subPrice}.priceText, componentsVO.{priceVO,titleVO,sizeTableVO}.
// Reviews: data.rateList[].{id,feedback,skuValueStr,feedbackDate}.

/** Name of the SKU property that holds sizes. */
const SIZE_PROP = /尺码|尺寸|码/;
/** Seller rating titles (宝贝描述 / 卖家服务 / 物流服务) and `type` codes. */
const DSR_BY_TYPE = { desc: 'description', serv: 'service', post: 'shipping' } as const;
const DSR_BY_TITLE: [RegExp, keyof typeof DSR_BY_TYPE][] = [[/描述/, 'desc'], [/物流/, 'post'], [/服务/, 'serv']];
const SALES_PREFIX = '已售 ';
/** Taobao's placeholder for a rating left without text. */
const DEFAULT_REVIEW = /^此用户没有填写评价[。.!！]?$/;
const IMAGE_URL_IN_TEXT = /(?:https?:)?\/\/[\w.-]*alicdn\.com\/[^\s"'<>()\\]+/gi;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;
/** Thumbnail suffix appended after the real extension, e.g. `.jpg_60x60q90.jpg` or `.png_.webp`. */
const THUMB_SUFFIX = /(\.(?:jpe?g|png|webp|gif))_[^/]*$/i;
const MAX_WALK_DEPTH = 12;

// ---- schemas (lenient: a bad field becomes undefined, a bad array element is skipped) ----

const str = z.string().optional().catch(undefined);
const strOrNum = z.union([z.string(), z.number()]).optional().catch(undefined);

/** Array whose invalid elements are dropped instead of failing the whole array. */
function arrayOf<T extends z.ZodType>(schema: T) {
  return z.array(z.unknown()).catch([]).transform((items) =>
    items.flatMap((x) => {
      const r = schema.safeParse(x);
      return r.success ? [r.data as z.output<T>] : [];
    }));
}

const Item = z.object({ title: str, vagueSellCount: str, images: arrayOf(z.string()) }).passthrough();
const Seller = z.object({
  shopName: str,
  evaluates: arrayOf(z.object({ title: str, type: str, score: strOrNum }).passthrough()),
}).passthrough();
const SkuValue = z.object({
  name: z.string(),
  image: str,
  sizeDescList: arrayOf(z.object({ key: str, value: strOrNum }).passthrough()),
}).passthrough();
const SkuBase = z.object({ props: arrayOf(z.object({ name: str, values: arrayOf(SkuValue) }).passthrough()) }).passthrough();
const PriceText = z.object({ priceText: strOrNum }).passthrough().optional().catch(undefined);
const SkuCore = z.object({
  sku2info: z.record(z.string(), z.unknown()).catch({}).transform((rec) =>
    Object.values(rec).flatMap((v) => {
      const r = z.object({ price: PriceText, subPrice: PriceText }).passthrough().safeParse(v);
      return r.success ? [r.data] : [];
    })),
}).passthrough();
const Components = z.object({
  priceVO: z.object({ price: PriceText, extraPrice: PriceText }).passthrough().optional().catch(undefined),
  titleVO: z.object({ salesDesc: str }).passthrough().optional().catch(undefined),
}).passthrough();

const RateBody = z.object({
  data: z.object({
    rateList: arrayOf(z.object({ id: z.union([z.string(), z.number()]), feedback: str, skuValueStr: str, feedbackDate: str }).passthrough()),
  }).passthrough(),
}).passthrough();
const RetBody = z.object({
  ret: z.union([z.array(z.unknown()), z.string()]).optional().catch(undefined),
  data: z.object({ url: str }).passthrough().optional().catch(undefined),
}).passthrough();

// ---- helpers -----------------------------------------------------------------

function sub<T extends z.ZodType>(schema: T, value: unknown): z.output<T> | undefined {
  const r = schema.safeParse(value);
  return r.success ? (r.data as z.output<T>) : undefined;
}

const numbers = (t: unknown): number[] =>
  [...String(t ?? '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => n > 0);

/** "已售 1万+" → 10000, "月销 3000+" → 3000, "已售 512" → 512. */
export function parseSalesCount(text: string | undefined): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(万)?/.exec(text ?? '');
  return m ? Math.round(Number(m[1]) * (m[2] ? 10000 : 1)) : undefined;
}

/** Protocol-relative or http URLs to https, thumbnail suffix stripped; null for non-http URLs. */
export function normalizeImageUrl(url: string): string | null {
  let u = url.trim();
  if (u.startsWith('//')) u = `https:${u}`;
  else if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
  if (!u.startsWith('https://')) return null;
  return u.replace(THUMB_SUFFIX, '$1');
}

function uniqueImages(urls: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    const u = normalizeImageUrl(raw);
    if (u) out.add(u);
  }
  return [...out];
}

// ---- product -----------------------------------------------------------------

/** Builds ProductData from the SSR `res`. Never throws; missing fields stay undefined. */
export function parseProduct(res: unknown, itemId: string): ProductData {
  const root = typeof res === 'object' && res !== null && !Array.isArray(res) ? (res as Record<string, unknown>) : {};
  const item = sub(Item, root.item);
  const seller = sub(Seller, root.seller);
  const props = sub(SkuBase, root.skuBase)?.props ?? [];
  const skus = sub(SkuCore, root.skuCore)?.sku2info ?? [];
  const comp = sub(Components, root.componentsVO);

  const product: ProductData = {
    itemId,
    title: item?.title?.trim() ?? '',
    skuSizes: [],
    shop: { extra: [] },
    images: { main: uniqueImages(item?.images ?? []), sku: [], detail: [] },
  };

  // Sizes and SKU images.
  const sizeProp = props.find((p) => p.name && SIZE_PROP.test(p.name));
  const sizeValues: SizeValue[] = (sizeProp?.values ?? []).filter((v) => v.name.trim() !== '');
  product.skuSizes = sizeValues.map((v) => v.name);
  product.images.sku = uniqueImages(props.flatMap((p) => p.values.flatMap((v) => (v.image ? [v.image] : []))));
  const sizeChart = structuredSizeChart(product.title, sizeValues, root.componentsVO);
  if (sizeChart) product.sizeChart = sizeChart;

  // Price: list price from the SKUs (else the displayed price), discounted price from subPrice (else extraPrice).
  let list = skus.flatMap((s) => numbers(s.price?.priceText));
  if (list.length === 0) list = numbers(comp?.priceVO?.price?.priceText);
  let discounted = skus.flatMap((s) => numbers(s.subPrice?.priceText).slice(0, 1));
  if (discounted.length === 0) discounted = numbers(comp?.priceVO?.extraPrice?.priceText).slice(0, 1);
  if (list.length > 0) {
    product.price = { min: Math.min(...list), max: Math.max(...list) };
    // Only a real discount: a "discounted" price equal to the list price would show "¥138 (was ¥138)".
    const coupon = discounted.length > 0 ? Math.min(...discounted) : undefined;
    if (coupon !== undefined && coupon < product.price.min) product.price.coupon = coupon;
  }

  // Sales.
  const salesText = comp?.titleVO?.salesDesc?.trim() || (item?.vagueSellCount ? `${SALES_PREFIX}${item.vagueSellCount}` : undefined);
  if (salesText) {
    product.salesText = salesText;
    const n = parseSalesCount(salesText);
    if (n !== undefined) product.salesCount = n;
  }

  // Shop.
  if (seller?.shopName) product.shop.name = seller.shopName;
  const dsr: NonNullable<ProductData['shop']['dsr']> = {};
  for (const e of seller?.evaluates ?? []) {
    const type = e.type && e.type in DSR_BY_TYPE
      ? (e.type as keyof typeof DSR_BY_TYPE)
      : DSR_BY_TITLE.find(([re]) => re.test(e.title ?? ''))?.[1];
    const score = Number.parseFloat(String(e.score ?? ''));
    if (type && Number.isFinite(score)) dsr[DSR_BY_TYPE[type]] = score;
  }
  if (Object.keys(dsr).length > 0) product.shop.dsr = dsr;

  return product;
}

// ---- reviews -----------------------------------------------------------------

/** Reviews from rate.detaillist.get bodies, in order, deduped by id, without empty or placeholder texts. */
export function parseReviews(bodies: unknown[]): Review[] {
  const seen = new Set<string>();
  const out: Review[] = [];
  for (const body of bodies) {
    for (const r of sub(RateBody, body)?.data.rateList ?? []) {
      const id = String(r.id);
      const text = r.feedback?.trim() ?? '';
      if (!id || seen.has(id) || !text || DEFAULT_REVIEW.test(text)) continue;
      seen.add(id);
      const review: Review = { id, text };
      if (r.skuValueStr) review.sku = r.skuValueStr;
      if (r.feedbackDate) review.date = r.feedbackDate;
      out.push(review);
    }
  }
  return out;
}

/** True when an mtop body is a captcha / anti-bot response. */
export function isCaptchaResponse(body: unknown): boolean {
  const b = sub(RetBody, body);
  if (!b) return false;
  const rets = Array.isArray(b.ret) ? b.ret : b.ret !== undefined ? [b.ret] : [];
  if (rets.some((r) => typeof r === 'string' && CAPTCHA_RET_CODES.some((code) => r.startsWith(code)))) return true;
  return CAPTCHA_URL.test(b.data?.url ?? '');
}

// ---- detail images -----------------------------------------------------------

/** Every alicdn image URL found anywhere in getdesc bodies (their HTML layout varies), in order. */
export function parseDescImages(bodies: unknown[]): string[] {
  const found: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > MAX_WALK_DEPTH) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(IMAGE_URL_IN_TEXT)) found.push(m[0]);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (typeof v === 'object' && v !== null) {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  for (const b of bodies) walk(b, 0);
  return uniqueImages(found).filter((u) => IMAGE_EXT.test(u));
}
