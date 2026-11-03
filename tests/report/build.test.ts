import { describe, it, expect } from 'vitest';
import { buildReport, formatSold } from '../../src/report/build';
import { DEFAULT_PROFILE as P } from '../../src/shared/schemas';
import type { CachedRun } from '../../src/profile/storage';
import type { FxRate, Profile, RefGarment, ReviewLabel, SizeChart } from '../../src/shared/types';

const hoodie: RefGarment = { label: 'hoodie', measures: { chest: { value: 120, tag: 'relaxed' }, length: { value: 71, tag: 'just_right' }, sleeve: { value: 62, tag: 'slightly_long' } } };
const profile: Profile = { ...P, body: { chest: 108, heightCm: 175, weightKg: 70 }, garments: { top: hoodie }, prefs: { ...P.prefs, top: 'slightly_relaxed' } };
const chart: SizeChart = {
  found: true, category: 'top', hwTable: [],
  rows: [
    { label: 'L', measures: { chest: 116, length: 70, sleeve: 60 } },
    { label: 'XL', measures: { chest: 122, length: 72, sleeve: 62 } },
    { label: 'XXL', measures: { chest: 128, length: 74, sleeve: 63 } },
  ],
};
const noChart: SizeChart = { found: false, category: 'top', rows: [], hwTable: [] };

const labels = (small: number, tts: number, large = 0): ReviewLabel[] => [
  ...Array.from({ length: small }, (_, i) => ({ idx: i, sentiment: 'pos' as const, sizing: 'runs_small' as const })),
  ...Array.from({ length: tts }, (_, i) => ({ idx: small + i, sentiment: 'pos' as const, sizing: 'true_to_size' as const })),
  ...Array.from({ length: large }, (_, i) => ({ idx: small + tts + i, sentiment: 'neg' as const, sizing: 'runs_large' as const })),
];

function run(over: Partial<CachedRun> = {}, ls: ReviewLabel[] = labels(4, 6)): CachedRun {
  return {
    at: 1,
    product: { itemId: '1', title: 't', skuSizes: ['L', 'XL', 'XXL'], shop: { extra: [] }, images: { main: [], sku: [], detail: [] } },
    reviews: ls.map(l => ({ id: String(l.idx), text: `评价${l.idx}` })),
    chart,
    analysis: { labels: ls, liked: ['soft'], disliked: [], flags: [], translations: {} },
    ...over,
  };
}

describe('buildReport sizing', () => {
  it('recommends XL and leans XXL when 40% say it runs small', () => {
    const r = buildReport(run(), profile, null);
    expect(r.summary.sizeTile).toBe('XL');
    expect(r.summary.reviewsLean).toBe('XXL?');
    expect(r.size!.reviewsSay).toBe('4 of 10 sizing comments say it runs small');
    expect(r.size!.chartSays).toBe('Chart says XL — Relaxed');
  });
  it('lean is null when below 30%', () => {
    const r = buildReport(run({}, labels(2, 8)), profile, null);
    expect(r.summary.reviewsLean).toBeNull();
  });
  it('lean is null when small equals large', () => {
    const r = buildReport(run({}, labels(3, 4, 3)), profile, null);
    expect(r.summary.reviewsLean).toBeNull();
  });
  it('leans one size down when reviews run large', () => {
    const r = buildReport(run({}, labels(0, 6, 4)), profile, null);
    expect(r.summary.reviewsLean).toBe('L?');
    expect(r.size!.reviewsSay).toBe('4 of 10 sizing comments say it runs large');
  });
  it('lean is null when already at the end row', () => {
    const r = buildReport(run({ fitOverride: 'oversized' }), profile, null);
    expect(r.summary.sizeTile).toBe('XXL');
    expect(r.summary.reviewsLean).toBeNull();
  });
  it('says true to size when no skew', () => {
    const r = buildReport(run({}, labels(0, 5)), profile, null);
    expect(r.size!.reviewsSay).toBe('5 of 5 say true to size');
  });
});

describe('buildReport fit override', () => {
  it('defaults current to usual', () => {
    const r = buildReport(run(), profile, null);
    expect(r.size!.fitChoice).toEqual({ category: 'top', usual: 'slightly_relaxed', current: 'slightly_relaxed' });
  });
  it('override changes recommendation only for this item', () => {
    const r = buildReport(run({ fitOverride: 'oversized' }), profile, null);
    expect(r.summary.sizeTile).toBe('XXL');
    expect(r.size!.fitChoice).toEqual({ category: 'top', usual: 'slightly_relaxed', current: 'oversized' });
    expect(profile.prefs.top).toBe('slightly_relaxed');
  });
  it('fitChoice is null without a chart', () => {
    expect(buildReport(run({ chart: noChart }), profile, null).size!.fitChoice).toBeNull();
  });
});

describe('buildReport without a chart', () => {
  const hw = { ...noChart, hwTable: [
    { label: 'M', heightMin: 160, heightMax: 170, weightMinKg: 50, weightMaxKg: 60 },
    { label: 'L', heightMin: 170, heightMax: 180, weightMinKg: 65, weightMaxKg: 75 },
  ] };
  it('uses the shop height/weight guide', () => {
    const r = buildReport(run({ chart: hw }, []), profile, null);
    expect(r.summary.sizeTile).toBe('Shop guide: L');
    expect(r.size!.fit).toBeNull();
    expect(r.size!.shopGuide).toBe("Shop's guide says L");
    expect(r.size!.chartSays).toBeNull();
  });
  it('says No chart without a guide', () => {
    const r = buildReport(run({ chart: noChart }, []), profile, null);
    expect(r.summary.sizeTile).toBe('No chart');
    expect(r.size!.chartFound).toBe(false);
  });
  it('lists nearby reviewers, grouping XL and XL码 together', () => {
    const near = (idx: number, sizeBought: string): ReviewLabel =>
      ({ idx, sentiment: 'pos', sizing: null, heightCm: 175, weightKg: 70, sizeBought });
    const ls = [near(0, 'XL'), near(1, 'XL码'), near(2, 'XL'), near(3, 'L'), near(4, 'xl')];
    const r = buildReport(run({ chart: noChart }, ls), profile, null);
    expect(r.size!.reviewsSay).toBe('People your height/weight bought XL (4), L (1)');
  });
});

describe('buildReport size section', () => {
  it('is null for non-clothing', () => {
    const other: SizeChart = { found: false, category: 'other', rows: [], hwTable: [] };
    const base = run({ chart: other });
    const r = buildReport({ ...base, product: { ...base.product, skuSizes: ['黑色', '白色'] } }, profile, null);
    expect(r.size).toBeNull();
  });
  it('is kept for other when SKUs look like sizes', () => {
    const other: SizeChart = { found: false, category: 'other', rows: [], hwTable: [] };
    const base = run({ chart: other });
    const r = buildReport({ ...base, product: { ...base.product, skuSizes: ['黑色 M', 'M码', '42'] } }, profile, null);
    expect(r.size).not.toBeNull();
    expect(r.size!.fitChoice).toBeNull();
  });
  it('uses the shoe preference for shoes', () => {
    const shoe: SizeChart = { found: true, category: 'shoe', hwTable: [], rows: [{ label: '42', measures: { footLength: 26.5 } }] };
    const p: Profile = { ...profile, prefs: { ...profile.prefs, shoe: 'fitted' } };
    const r = buildReport(run({ chart: shoe, fitOverride: 'oversized' }, []), p, null);
    expect(r.size!.fitChoice).toEqual({ category: 'shoe', usual: 'fitted', current: 'oversized' });
  });
});

describe('formatSold', () => {
  it.each([
    ['已售 4000+', '4000+'], ['月销 300+', '300+'], ['已抢 88', '88'], ['已售 1万+', '10,000+'],
    ['已售 1.5万+', '15,000+'], ['1000+人付款', '1000+'], ['unknown', 'unknown'],
  ])('%s → %s', (raw, out) => expect(formatSold(raw)).toBe(out));
  it('keeps the stored salesText and shows English in the report', () => {
    const base = run();
    const r = buildReport({ ...base, product: { ...base.product, salesText: '已售 4000+' } }, profile, null);
    expect(r.summary.sold).toBe('4000+ sold');
    expect(r.shop.rows).toContainEqual(['Sold', '4000+']);
  });
});

describe('buildReport reviews, quotes, flags', () => {
  it('computes positive percentage and totals', () => {
    const ls: ReviewLabel[] = [
      { idx: 0, sentiment: 'pos', sizing: null }, { idx: 1, sentiment: 'pos', sizing: null },
      { idx: 2, sentiment: 'neg', sizing: null }, { idx: 3, sentiment: 'mixed', sizing: null },
    ];
    const r = buildReport(run({}, ls), profile, null);
    expect(r.reviews.positivePct).toBe(50);
    expect(r.summary.positivePct).toBe(50);
    expect(r.reviews.total).toBe(4);
    expect(r.reviews.liked).toEqual(['soft']);
  });
  it('null percentage without labels', () => {
    expect(buildReport(run({ analysis: null }), profile, null).reviews.positivePct).toBeNull();
  });
  it('quotes keep stored Chinese text verbatim and truncate long ones', () => {
    const base = run({}, labels(1, 1));
    const long = '长'.repeat(200);
    const r0 = { ...base, reviews: [{ id: 'a', text: '偏小，建议拍大一码' }, { id: 'b', text: long }],
      analysis: { ...base.analysis!, translations: { 0: 'Runs small', 1: 'Nice' } } };
    const r = buildReport(r0, profile, null);
    expect(r.size!.quotes[0]).toEqual({ zh: '偏小，建议拍大一码', en: 'Runs small' });
    const all = [...r.size!.quotes, ...r.reviews.quotes];
    const trimmed = all.find(q => q.en === 'Nice')!;
    expect(trimmed.zh).toBe('长'.repeat(140) + '…');
  });
  it('sizing quotes prefer reviewers with height/weight, max 3; review quotes max 4 others', () => {
    const ls: ReviewLabel[] = Array.from({ length: 10 }, (_, i) => ({
      idx: i, sentiment: 'pos' as const, sizing: i < 5 ? 'runs_small' as const : null,
      ...(i === 4 ? { heightCm: 170, weightKg: 60 } : {}),
    }));
    const base = run({}, ls);
    const translations = Object.fromEntries(ls.map(l => [l.idx, `en${l.idx}`]));
    const r = buildReport({ ...base, analysis: { ...base.analysis!, translations } }, profile, null);
    expect(r.size!.quotes).toHaveLength(3);
    expect(r.size!.quotes[0]!.en).toBe('en4');
    expect(r.reviews.quotes).toHaveLength(4);
    const used = new Set(r.size!.quotes.map(q => q.en));
    expect(r.reviews.quotes.some(q => used.has(q.en))).toBe(false);
  });
  it('sorts flags fit, quality, shop with review-count sources', () => {
    const base = run();
    const r = buildReport({
      ...base,
      product: { ...base.product, shop: { dsr: { description: 4.0 }, extra: [] } },
      analysis: { ...base.analysis!, flags: [
        { group: 'quality', text: 'Pilling', reviewIdx: [1, 2] },
        { group: 'fit', text: 'Tight arms', reviewIdx: [3, 4, 5] },
      ] },
    }, profile, null);
    expect(r.flags.map(f => f.group)).toEqual(['fit', 'quality', 'shop']);
    expect(r.flags[0]!.source).toBe('3 reviews');
    expect(r.flags[2]!.source).toBe('shop page');
  });
});

describe('buildReport price and shop', () => {
  it('formats the price through formatPrice', () => {
    const fx: FxRate = { cnyToCad: 0.1945, date: '2026-10-30', source: 'ecb' };
    const base = run();
    const r = buildReport({ ...base, product: { ...base.product, price: { min: 129, max: 129 } } }, profile, fx);
    expect(r.price!.cad).toBe('CA$25.09');
    expect(buildReport(base, profile, fx).price).toBeNull();
  });
  it('builds shop rows and omits missing values', () => {
    const base = run();
    const product = { ...base.product, salesText: '已售 1000+',
      shop: { dsr: { description: 4.8, shipping: 4.7 }, ageYears: 0.5, extra: ['天猫'] } };
    const r = buildReport({ ...base, product }, profile, null);
    expect(r.summary.sold).toBe('1000+ sold');
    expect(r.shop.rows).toEqual([
      ['Sold', '1000+'], ['Description match', '4.8'], ['Shipping', '4.7'], ['Shop age', '6 months'], ['Info', '天猫'],
    ]);
  });
  it('formats shop age in years without trailing .0', () => {
    const base = run();
    const mk = (ageYears: number) => buildReport({ ...base, product: { ...base.product, shop: { ageYears, extra: [] } } }, profile, null).shop.rows;
    expect(mk(3)).toEqual([['Shop age', '3 years']]);
    expect(mk(2.46)).toEqual([['Shop age', '2.5 years']]);
  });
});
