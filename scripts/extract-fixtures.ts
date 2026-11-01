// Extracts sanitized API response bodies from a browser HAR export.
// Usage: npx tsx scripts/extract-fixtures.ts <in.har> <outdir>
//        npx tsx scripts/extract-fixtures.ts --fixtures <rawdir> <fixturesdir>   (npm run fixtures)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// TODO(later task): the canonical list moves to src/collect/endpoints.ts.
export const DEFAULT_API_PATTERNS: RegExp[] = [
  /mtop\.taobao\.pcdetail\.data\.get/i,
  /mtop\.taobao\.rate\.detaillist\.get/i,
];

export interface ExtractedResponse {
  api: string;
  url: string;
  body: unknown;
}

const harSchema = z.object({
  log: z.object({
    entries: z.array(
      z.object({
        request: z.object({ url: z.string() }).loose(),
        response: z
          .object({
            content: z.object({ text: z.string().optional(), encoding: z.string().optional() }).loose().optional(),
          })
          .loose()
          .optional(),
      }),
    ),
  }),
});

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  // JSONP: callback({...}) with optional trailing semicolon
  const jsonp = /^[\w$.]+\(([\s\S]*)\)\s*;?$/.exec(trimmed);
  return JSON.parse(jsonp ? (jsonp[1] ?? '') : trimmed);
}

/** Returns response bodies for entries whose URL matches a pattern. Request headers, cookies and query strings are never copied. */
export function extractFromHar(har: unknown, apiPatterns: RegExp[]): ExtractedResponse[] {
  const parsed = harSchema.parse(har);
  const results: ExtractedResponse[] = [];
  for (const entry of parsed.log.entries) {
    const rawUrl = entry.request.url;
    const pattern = apiPatterns.find((p) => p.test(rawUrl));
    if (!pattern) continue;
    const content = entry.response?.content;
    if (!content?.text) continue;
    const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    let body: unknown;
    try {
      body = parseBody(text);
    } catch {
      continue;
    }
    const url = rawUrl.split(/[?#]/)[0] ?? rawUrl;
    const api = /mtop\.[\w.]+/i.exec(url)?.[0]?.toLowerCase().replace(/\.$/, '') ?? pattern.source;
    results.push({ api, url, body });
  }
  return results;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Index just past the JSON object that starts at `start` (a left brace), skipping braces inside strings. */
function endOfJsonObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  throw new Error('Unterminated __ICE_APP_CONTEXT__ object in HTML');
}

/** Finds the server-rendered `window.__ICE_APP_CONTEXT__` object and returns `loaderData.home.data.res`. */
export function extractSsrFromHtml(html: string): unknown {
  const marker = html.indexOf('__ICE_APP_CONTEXT__');
  if (marker < 0) throw new Error('No __ICE_APP_CONTEXT__ found in HTML');
  const assign = /var\s+b\s*=\s*\{/.exec(html.slice(marker));
  if (!assign) throw new Error('__ICE_APP_CONTEXT__ found, but no "var b = {...}" assignment follows it');
  const start = marker + assign.index + assign[0].length - 1;
  const ctx: unknown = JSON.parse(html.slice(start, endOfJsonObject(html, start)));
  const loader = isObject(ctx) ? ctx.loaderData : undefined;
  const home = isObject(loader) ? loader.home : undefined;
  const data = isObject(home) ? home.data : undefined;
  if (!isObject(data) || !isObject(data.res)) {
    throw new Error('__ICE_APP_CONTEXT__ has no loaderData.home.data.res');
  }
  return data.res;
}

// ALLOWLIST sanitising: only the fields listed here are ever copied into a fixture.
// Anything not named is dropped, so new buyer/reviewer fields cannot leak by default.
const REVIEW_ENTRY_KEYS = ['id', 'feedback', 'skuValueStr', 'feedbackDate', 'rateType', 'auctionNumId'];
const REVIEW_TOP_KEYS = ['api', 'ret', 'v'];
const REVIEW_COUNT_KEY = /^(feed\w*Count(Fuzzy)?|total\w*|hasNext)$/;

function pick(src: unknown, keys: string[]): Json {
  const out: Json = {};
  if (!isObject(src)) return out;
  for (const k of keys) if (src[k] !== undefined) out[k] = structuredClone(src[k]);
  return out;
}

/** Returns a copy of a rate.detaillist body holding only review text, sku label, date, ids and the counts. */
export function sanitizeReviews(body: unknown): unknown {
  if (!isObject(body)) return {};
  const out = pick(body, REVIEW_TOP_KEYS);
  if (isObject(body.data)) {
    const data: Json = {};
    for (const [k, v] of Object.entries(body.data)) {
      if (REVIEW_COUNT_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) data[k] = v;
    }
    if (Array.isArray(body.data.rateList)) data.rateList = body.data.rateList.map((e) => pick(e, REVIEW_ENTRY_KEYS));
    out.data = data;
  }
  return out;
}

/** Identifiers of the logged-in buyer found in the raw page: `__itempage_userinfo` values and any `user_id` value. */
export function findBuyerSecrets(html: string): string[] {
  const secrets = new Set<string>();
  const info = /__itempage_userinfo\s*=\s*\{/.exec(html);
  if (info) {
    const start = info.index + info[0].length - 1;
    try {
      const obj: unknown = JSON.parse(html.slice(start, endOfJsonObject(html, start)));
      if (isObject(obj)) {
        for (const v of Object.values(obj)) if (typeof v === 'string' || typeof v === 'number') secrets.add(String(v));
      }
    } catch {
      // handled below: no secrets found means we refuse to continue
    }
  }
  for (const m of html.matchAll(/"user_id"\s*:\s*"?(\d{5,})/g)) if (m[1]) secrets.add(m[1]);
  const found = [...secrets].filter((s) => s.length >= 5);
  if (found.length === 0) throw new Error('Could not locate the buyer id in the raw page; refusing to write fixtures');
  return found;
}

/** Throws (without echoing any secret) if a buyer identifier appears in any output text. */
export function assertNoBuyerSecrets(outputs: string[], secrets: string[]): void {
  for (const s of secrets) {
    if (outputs.some((o) => o.includes(s))) throw new Error('Buyer identifier leaked into fixture output; nothing written');
  }
}

const IDENTITY_URL = /userFlag=|userId=|uid=/i;

/** Removes any string carrying a user identifier in a URL, from objects and arrays alike. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !(typeof v === 'string' && IDENTITY_URL.test(v))).map(scrub);
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && IDENTITY_URL.test(v)) continue;
    if (/recommend/i.test(k)) continue; // e.g. showSizeRecommend: a purchase-history feature flag
    out[k] = scrub(v);
  }
  return out;
}

/**
 * Builds the committed SSR fixture from an allowlist of subtrees: item, seller, sku data, prices, industry params
 * and the generic size tables. Buyer data (delivery, size profile, reviewer previews) is never copied.
 */
export function sanitizeSsr(res: unknown): unknown {
  const r = isObject(res) ? res : {};
  const sku2info: Json = {};
  for (const [id, s] of Object.entries(sub(sub(r, 'skuCore'), 'sku2info'))) {
    const sku: Json = {
      price: pick(sub(s, 'price'), ['priceTitle', 'priceText', 'priceDesc', 'priceMoney']),
      ...pick(s, ['quantity', 'quantityText']),
    };
    if (isObject(sub(s, 'subPrice')) && Object.keys(sub(s, 'subPrice')).length > 0) {
      sku.subPrice = pick(sub(s, 'subPrice'), ['priceTitle', 'priceText', 'priceMoney']);
    }
    sku2info[id] = sku;
  }
  const components = sub(r, 'componentsVO');
  const sizeData = sub(sub(sub(sub(components, 'sizeTableVO'), 'sizeTableTaoDetailView'), 'datas'), 'sizeData');
  const out: Json = {
    item: pick(r.item, ['title', 'itemId', 'vagueSellCount', 'images', 'spuId']),
    seller: pick(r.seller, [
      'shopName', 'sellerNick', 'shopId', 'sellerId', 'userId', 'evaluates', 'creditLevel', 'certText', 'sellerType', 'pcShopUrl',
    ]),
    skuBase: pick(r.skuBase, ['props', 'skus']),
    skuCore: { sku2info },
    plusViewVO: pick(r.plusViewVO, ['industryParamVO']),
    componentsVO: {
      ...pick(components, ['priceVO']),
      titleVO: pick(components.titleVO, ['salesDesc']),
      ...(Object.keys(sizeData).length > 0
        ? {
            sizeTableVO: {
              sizeTableTaoDetailView: {
                datas: { sizeData: pick(sizeData, ['optionLine', 'heightTable', 'sizeTable']) },
              },
            },
          }
        : {}),
    },
  };
  return scrub(out);
}

export interface Expected {
  itemId?: string;
  title?: string;
  skuSizes: string[];
  priceMin?: number;
  priceMax?: number;
  priceDiscount?: number;
  sales?: string;
  sellerDsr?: Record<string, number>;
  firstReviews: string[];
  sizeDescList?: Record<string, Record<string, string>>;
}

function sub(o: unknown, key: string): Json {
  const v = isObject(o) ? o[key] : undefined;
  return isObject(v) ? v : {};
}

/** Values visible on the page, read from the sanitized SSR data and review bodies. */
export function buildExpected(ssr: unknown, reviews: unknown[]): Expected {
  const item = sub(ssr, 'item');
  const out: Expected = { skuSizes: [], firstReviews: [] };
  if (typeof item.itemId === 'string') out.itemId = item.itemId;
  if (typeof item.title === 'string') out.title = item.title;

  const props = sub(ssr, 'skuBase').props;
  const sizeProp = (Array.isArray(props) ? props : [])
    .filter(isObject)
    .find((p) => typeof p.name === 'string' && /尺码|尺寸|size/i.test(p.name));
  const sizeValues = Array.isArray(sizeProp?.values) ? sizeProp.values.filter(isObject) : [];
  out.skuSizes = sizeValues.map((v) => String(v.name));
  const descs: Record<string, Record<string, string>> = {};
  for (const v of sizeValues) {
    if (!Array.isArray(v.sizeDescList)) continue;
    descs[String(v.name)] = Object.fromEntries(
      v.sizeDescList.filter(isObject).map((d) => [String(d.key), String(d.value)]),
    );
  }
  if (Object.keys(descs).length > 0) out.sizeDescList = descs;

  const prices = Object.values(sub(sub(ssr, 'skuCore'), 'sku2info'))
    .map((s) => Number(sub(s, 'price').priceMoney) / 100)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length > 0) {
    out.priceMin = Math.min(...prices);
    out.priceMax = Math.max(...prices);
  }
  // Lowest price after shop or platform discounts (subPrice), when the page shows one.
  const discounted = Object.values(sub(sub(ssr, 'skuCore'), 'sku2info'))
    .map((s) => Number(sub(s, 'subPrice').priceMoney) / 100)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (discounted.length > 0) out.priceDiscount = Math.min(...discounted);

  const salesDesc = sub(sub(ssr, 'componentsVO'), 'titleVO').salesDesc;
  const sales = typeof salesDesc === 'string' ? salesDesc : item.vagueSellCount;
  if (typeof sales === 'string') out.sales = sales;

  const evaluates = sub(ssr, 'seller').evaluates;
  const dsr: Record<string, number> = {};
  for (const e of Array.isArray(evaluates) ? evaluates.filter(isObject) : []) {
    const n = Number(String(e.score).trim());
    if (typeof e.type === 'string' && Number.isFinite(n)) dsr[e.type] = n;
  }
  if (Object.keys(dsr).length > 0) out.sellerDsr = dsr;

  for (const body of reviews) {
    const list = sub(body, 'data').rateList;
    for (const r of Array.isArray(list) ? list.filter(isObject) : []) {
      if (typeof r.feedback === 'string') out.firstReviews.push(r.feedback);
    }
  }
  out.firstReviews = out.firstReviews.slice(0, 3);
  return out;
}

/** Builds <fixturesDir>/<name>/{ssr,reviews,expected}.json for every <name>.har + <name>.html pair in rawDir. */
export function buildFixtureSets(rawDir: string, fixturesDir: string): string[] {
  const names = readdirSync(rawDir)
    .filter((f) => f.endsWith('.har') && existsSync(resolve(rawDir, f.replace(/\.har$/, '.html'))))
    .map((f) => f.replace(/\.har$/, ''));
  // Build and check everything first so a leak writes nothing at all.
  const built = names.map((name) => {
    const html = readFileSync(resolve(rawDir, `${name}.html`), 'utf8');
    const ssr = sanitizeSsr(extractSsrFromHtml(html));
    const har: unknown = JSON.parse(readFileSync(resolve(rawDir, `${name}.har`), 'utf8'));
    const reviews = extractFromHar(har, [/mtop\.taobao\.rate\.detaillist\.get/i])
      .filter((r) => Array.isArray(sub(r.body, 'data').rateList))
      .map((r) => sanitizeReviews(r.body));
    const files = {
      'ssr.json': JSON.stringify(ssr, null, 2),
      'reviews.json': JSON.stringify(reviews, null, 2),
      'expected.json': JSON.stringify(buildExpected(ssr, reviews), null, 2),
    };
    assertNoBuyerSecrets(Object.values(files), findBuyerSecrets(html));
    return { name, files, count: reviews.length };
  });
  for (const { name, files, count } of built) {
    const outDir = resolve(fixturesDir, name);
    mkdirSync(outDir, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(resolve(outDir, file), text);
    console.log(`${name}: ${count} review responses written to ${outDir}`);
  }
  return names;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === '--fixtures') {
    const [rawDir, fixturesDir] = args.slice(1);
    if (!rawDir || !fixturesDir) {
      console.error('Usage: npx tsx scripts/extract-fixtures.ts --fixtures <rawdir> <fixturesdir>');
      process.exit(1);
    }
    buildFixtureSets(rawDir, fixturesDir);
    return;
  }
  const [inFile, outDir] = args;
  if (!inFile || !outDir) {
    console.error('Usage: npx tsx scripts/extract-fixtures.ts <in.har> <outdir>');
    process.exit(1);
  }
  const results = extractFromHar(JSON.parse(readFileSync(inFile, 'utf8')), DEFAULT_API_PATTERNS);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'responses.json'), JSON.stringify(results, null, 2));
  const apis = [...new Set(results.map((r) => r.api))];
  console.log(`Wrote ${results.length} responses (${apis.join(', ') || 'none'}) to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
