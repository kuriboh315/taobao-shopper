import { recommend } from '../fit/engine';
import { nearbyReviewers, pickFromHwTable } from '../fit/fallbacks';
import type { CachedRun } from '../profile/storage';
import { formatPrice } from '../shared/fx';
import { normalizeSizeLabel } from '../shared/sizeLabel';
import type { FitPref, FitResult, FxRate, Profile, ReviewLabel } from '../shared/types';
import { formatShopAge, shopFlags } from './shopFlags';

export interface Quote { zh: string; en: string }
export interface Flag { group: 'fit' | 'quality' | 'shop'; text: string; source: string }
export interface Report {
  summary: { sizeTile: string; reviewsLean: string | null; positivePct: number | null; sold: string | null };
  price: ReturnType<typeof formatPrice>;
  size: null | {
    chartFound: boolean; fit: FitResult | null; shopGuide: string | null;
    chartSays: string | null; reviewsSay: string | null; quotes: Quote[];
    fitChoice: null | { category: 'top' | 'outerwear' | 'bottom' | 'shoe'; usual: FitPref; current: FitPref };
  };
  reviews: { positivePct: number | null; total: number; liked: string[]; disliked: string[]; quotes: Quote[] };
  shop: { rows: [string, string][] };
  flags: Flag[];
}

const SIZE_LIKE = /^(X{0,4}S|M|X{0,5}L|均码|\d{2,3}(\.5)?)$/;
const LEAN_THRESHOLD = 0.3;
const QUOTE_MAX_CHARS = 140;
const GROUP_ORDER: Flag['group'][] = ['fit', 'quality', 'shop'];

const isSizeLike = (label: string): boolean => SIZE_LIKE.test(normalizeSizeLabel(label));
const clip = (s: string): string => (s.length > QUOTE_MAX_CHARS ? `${s.slice(0, QUOTE_MAX_CHARS)}…` : s);

function positivePct(labels: ReviewLabel[]): number | null {
  if (labels.length === 0) return null;
  const pos = labels.filter(l => l.sentiment === 'pos').length;
  return Math.round((100 * pos) / labels.length);
}

/** Sizing-comment consensus: the sentence plus the direction reviews lean (+1 up, -1 down, 0 none). */
function consensus(labels: ReviewLabel[]): { say: string | null; dir: -1 | 0 | 1 } {
  const sized = labels.filter(l => l.sizing !== null);
  const n = sized.length;
  if (n === 0) return { say: null, dir: 0 };
  const count = (s: ReviewLabel['sizing']) => sized.filter(l => l.sizing === s).length;
  const small = count('runs_small');
  const large = count('runs_large');
  const tts = count('true_to_size');
  let say: string;
  if (small >= large && small > 0) say = `${small} of ${n} sizing comments say it runs small`;
  else if (large > small) say = `${large} of ${n} sizing comments say it runs large`;
  else say = `${tts} of ${n} say true to size`;
  const dir = small > large && small >= LEAN_THRESHOLD * n ? 1 : large > small && large >= LEAN_THRESHOLD * n ? -1 : 0;
  return { say, dir };
}

function pickQuotes(run: CachedRun): { sizing: Quote[]; review: Quote[] } {
  const labels = run.analysis?.labels ?? [];
  const translations = run.analysis?.translations ?? {};
  const quote = (idx: number): Quote | null => {
    const review = run.reviews[idx];
    const en = translations[idx];
    return review && en !== undefined ? { zh: clip(review.text), en } : null;
  };
  const candidates = labels.filter(l => l.sizing !== null && quote(l.idx));
  const measured = candidates.filter(l => l.heightCm !== undefined || l.weightKg !== undefined);
  const rest = candidates.filter(l => !measured.includes(l));
  const sizingIdx = [...measured, ...rest].slice(0, 3).map(l => l.idx);
  const reviewIdx = Object.keys(translations).map(Number)
    .filter(i => !sizingIdx.includes(i)).sort((a, b) => a - b).slice(0, 4);
  const toQuotes = (ids: number[]) => ids.map(quote).filter((q): q is Quote => q !== null);
  return { sizing: toQuotes(sizingIdx), review: toQuotes(reviewIdx) };
}

function shopRows(run: CachedRun): [string, string][] {
  const { shop, salesText, salesCount } = run.product;
  const sold = salesText ?? (salesCount !== undefined ? String(salesCount) : undefined);
  const rows: [string, string | undefined][] = [
    ['Sold', sold],
    ['Description match', shop.dsr?.description?.toString()],
    ['Service', shop.dsr?.service?.toString()],
    ['Shipping', shop.dsr?.shipping?.toString()],
    ['Shop age', shop.ageYears !== undefined ? formatShopAge(shop.ageYears) : undefined],
  ];
  const out = rows.filter((r): r is [string, string] => r[1] !== undefined);
  for (const e of shop.extra) out.push(['Info', e]);
  return out;
}

export function buildReport(run: CachedRun, profile: Profile, fx: FxRate | null): Report {
  const { chart, product } = run;
  const labels = (run.analysis?.labels ?? []).map(l => (l.sizeBought ? { ...l, sizeBought: normalizeSizeLabel(l.sizeBought) } : l));
  const hasChart = chart.found && chart.rows.length > 0;
  const cat = chart.category;
  const prefCat = cat === 'top' || cat === 'outerwear' || cat === 'bottom' || cat === 'shoe' ? cat : null;
  const pct = positivePct(labels);
  const quotes = pickQuotes(run);
  const { say: consensusSay, dir } = consensus(labels);

  // Per-item fit: start from the usual preference; the override only affects this item.
  const usual = prefCat ? profile.prefs[prefCat] : null;
  const current = usual && prefCat ? (run.fitOverride ?? usual) : null;
  const fitChoice = hasChart && prefCat && usual && current ? { category: prefCat, usual, current } : null;
  const fit = hasChart
    ? recommend(chart, prefCat && current ? { ...profile, prefs: { ...profile.prefs, [prefCat]: current } } : profile)
    : null;
  const rec = fit?.recommended ?? null;

  let lean: string | null = null;
  if (rec && dir !== 0) {
    const leanRow = chart.rows[chart.rows.findIndex(r => r.label === rec) + dir];
    if (leanRow && leanRow.label !== rec) lean = `${leanRow.label}?`;
  }

  const shopGuide = hasChart ? null : pickFromHwTable(chart.hwTable, profile.body);
  const near = nearbyReviewers(labels, profile.body);
  const nearSay = !hasChart && near.length
    ? `People your height/weight bought ${near.map(g => `${g.sizeBought} (${g.count})`).join(', ')}`
    : null;
  const reviewsSay = [consensusSay, nearSay].filter(Boolean).join('. ') || null;

  const note = rec ? fit?.sizes.find(s => s.label === rec)?.note : undefined;
  const chartSays = rec ? `Chart says ${rec}${note && note !== '—' ? ` — ${note}` : ''}` : null;
  const sizeTile = hasChart ? rec ?? '—' : shopGuide ? `Shop guide: ${shopGuide}` : 'No chart';

  const showSize = !(cat === 'other' && !hasChart && !product.skuSizes.some(isSizeLike));

  const flags: Flag[] = [
    ...(run.analysis?.flags ?? []).map(f => ({ group: f.group, text: f.text, source: `${f.reviewIdx.length} reviews` })),
    ...shopFlags(product),
  ].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));

  return {
    summary: {
      sizeTile,
      reviewsLean: lean,
      positivePct: pct,
      sold: product.salesText ?? (product.salesCount !== undefined ? String(product.salesCount) : null),
    },
    price: formatPrice(product.price, fx),
    size: showSize
      ? {
        chartFound: hasChart, fit, chartSays, reviewsSay, quotes: quotes.sizing, fitChoice,
        shopGuide: shopGuide ? `Shop's guide says ${shopGuide}` : null,
      }
      : null,
    reviews: {
      positivePct: pct, total: run.reviews.length,
      liked: run.analysis?.liked ?? [], disliked: run.analysis?.disliked ?? [], quotes: quotes.review,
    },
    shop: { rows: shopRows(run) },
    flags,
  };
}
