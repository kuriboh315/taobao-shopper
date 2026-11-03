import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isCaptchaResponse, normalizeImageUrl, parseDescImages, parseProduct, parseReviews, parseSalesCount,
} from '../../src/collect/parse';
import { inferCategory } from '../../src/collect/parse-sizes';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const SETS = ['tee', 'pants', 'shoes', 'other', 'tmall'] as const;

interface Expected {
  itemId: string; title: string; skuSizes: string[]; firstReviews: string[];
  priceMin: number; priceMax: number; priceDiscount?: number; sales: string;
  sellerDsr: { desc: number; serv: number; post: number };
  sizeDescList?: Record<string, Record<string, string>>;
}

const load = (set: string, file: string): unknown =>
  JSON.parse(readFileSync(resolve(FIXTURES, set, file), 'utf8'));

describe.each(SETS)('fixture %s', (set) => {
  const ssr = load(set, 'ssr.json');
  const reviews = load(set, 'reviews.json') as unknown[];
  const exp = load(set, 'expected.json') as Expected;
  const p = parseProduct(ssr, exp.itemId);

  it('reads title, item id, sizes, sales and DSR', () => {
    expect(p.itemId).toBe(exp.itemId);
    expect(p.title).toBe(exp.title);
    expect(p.skuSizes).toEqual(exp.skuSizes);
    expect(p.salesText).toBe(exp.sales);
    expect(p.shop.dsr).toEqual({
      description: exp.sellerDsr.desc, service: exp.sellerDsr.serv, shipping: exp.sellerDsr.post,
    });
    expect(p.shop.name).toBeTruthy();
  });

  it('reads list price range and discounted price', () => {
    expect(p.price?.min).toBe(exp.priceMin);
    expect(p.price?.max).toBe(exp.priceMax);
    expect(p.price?.coupon).toBe(exp.priceDiscount);
  });

  it('reads main images as full-size https URLs', () => {
    expect(p.images.main.length).toBeGreaterThan(0);
    for (const u of [...p.images.main, ...p.images.sku]) expect(u).toMatch(/^https:\/\//);
    expect(p.images.detail).toEqual([]);
  });

  it('parses the expected first reviews in order', () => {
    const r = parseReviews(reviews);
    // `other` has the same review (id 1313262441865) on two pages; expected.json lists it twice, parseReviews once.
    const want = set === 'other' ? exp.firstReviews.slice(0, 1) : exp.firstReviews;
    expect(r.slice(0, want.length).map(x => x.text)).toEqual(want);
    if (set === 'other') expect(r.map(x => x.id)).toEqual(['1313262441865']);
    expect(new Set(r.map(x => x.id)).size).toBe(r.length);
    for (const x of r) expect(x.text.trim()).not.toBe('');
  });
});

describe('structured size chart', () => {
  it('builds the pants chart from sizeDescList', () => {
    const p = parseProduct(load('pants', 'ssr.json'), '845432953096');
    const c = p.sizeChart!;
    expect(c.found).toBe(true);
    expect(c.category).toBe('bottom');
    expect(c.rows.map(r => r.label)).toEqual(['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']);
    expect(c.rows.map(r => r.measures.waist)).toEqual([68, 72, 76, 80, 84, 88, 92]);
    expect(c.rows.map(r => r.measures.hips)).toEqual([110, 112, 116, 118, 120, 124, 128]);
    expect(c.rows.map(r => r.measures.length)).toEqual([102, 103, 104, 105, 106, 107, 108]);
    // Weight guidance from the SKU labels, 斤 halved to kg.
    expect(c.hwTable[0]).toEqual({ label: 'S', weightMinKg: 49, weightMaxKg: 53.5 });
    expect(c.hwTable[1]).toEqual({ label: 'M', weightMinKg: 54, weightMaxKg: 58 });
    expect(c.hwTable).toHaveLength(7);
  });

  it('builds the shoes chart from the size-table component', () => {
    const c = parseProduct(load('shoes', 'ssr.json'), '859369109395').sizeChart!;
    expect(c.found).toBe(true);
    expect(c.category).toBe('shoe');
    expect(c.rows[0]).toEqual({ label: '36女码', measures: { footLength: 23 } });
    expect(c.rows.at(-1)).toEqual({ label: '46', measures: { footLength: 28 } });
    expect(c.rows).toHaveLength(11);
  });

  it.each(['tee', 'other', 'tmall'])('has no size chart for %s', (set) => {
    expect(parseProduct(load(set, 'ssr.json'), '1').sizeChart).toBeUndefined();
  });

  it('reads both size-table orientations and the height/weight grid', () => {
    const col = (...v: string[]) => ({ data: v.map(value => ({ value })) });
    const table = (code: string, columns: ReturnType<typeof col>[]) =>
      ({ code, data: [{ data: { columnsData: columns } }] });
    const res = {
      item: { title: '纯棉T恤', itemId: '9' },
      componentsVO: { sizeTableVO: { sizeTableTaoDetailView: { datas: { sizeData: {
        sizeTable: table('sizeTable', [col('尺码', 'M', 'L'), col('胸围', '104', '110'), col('衣长', '70cm', '72cm'), col('备注', 'x', 'y')]),
        heightTable: table('heightTable', [col('身高/体重', '165-170', '170-175'), col('50-65', 'M', '-'), col('65-70', 'L', 'L')]),
      } } } } },
    };
    const c = parseProduct(res, '9').sizeChart!;
    expect(c.category).toBe('top');
    expect(c.rows).toEqual([
      { label: 'M', measures: { chest: 104, length: 70 } },
      { label: 'L', measures: { chest: 110, length: 72 } },
    ]);
    expect(c.hwTable).toEqual([
      { label: 'M', heightMin: 165, heightMax: 170, weightMinKg: 50, weightMaxKg: 65 },
      { label: 'L', heightMin: 165, heightMax: 170, weightMinKg: 65, weightMaxKg: 70 },
      { label: 'L', heightMin: 170, heightMax: 175, weightMinKg: 65, weightMaxKg: 70 },
    ]);
  });

  describe('height/weight table units', () => {
    const col = (...v: string[]) => ({ data: v.map(value => ({ value })) });
    const hw = (corner: string, w1: string, w2: string) => parseProduct({
      item: { title: '裤子' },
      componentsVO: { sizeTableVO: { sizeTableTaoDetailView: { datas: { sizeData: {
        heightTable: { data: [{ data: { columnsData: [col(corner, '170-175'), col(w1, 'M'), col(w2, 'L')] } }] },
      } } } } },
    }, 'x').sizeChart!.hwTable.map(r => [r.weightMinKg, r.weightMaxKg]);

    it('treats an unlabelled table with weights over 110 as 斤', () => {
      expect(hw('身高/体重', '100-120', '121-140')).toEqual([[50, 60], [60.5, 70]]);
    });

    it('treats an unlabelled table with small weights as kg', () => {
      expect(hw('身高/体重', '50-60', '60-70')).toEqual([[50, 60], [60, 70]]);
    });

    it('lets explicit labels win', () => {
      expect(hw('身高/体重(kg)', '100-120', '121-140')).toEqual([[100, 120], [121, 140]]);
      expect(hw('身高/体重', '80-100斤', '100-110斤')).toEqual([[40, 50], [50, 55]]);
    });
  });

  it('reads body guidance from labels in several styles', () => {
    const res = {
      item: { title: '夹克外套', itemId: '9' },
      skuBase: { props: [{ name: '尺码', values: [
        { name: 'M（108-116斤）', sizeDescList: [{ key: '胸围', value: '110cm' }, { key: '未知', value: '3' }] },
        { name: 'XL 120-140斤（约60-70kg）', sizeDescList: [{ key: '肩宽', value: '480mm' }] },
        { name: '175/88A', sizeDescList: [{ key: '袖长', value: '62.5' }] },
      ] }] },
    };
    const p = parseProduct(res, '9');
    expect(p.skuSizes).toEqual(['M（108-116斤）', 'XL 120-140斤（约60-70kg）', '175/88A']);
    const c = p.sizeChart!;
    expect(c.category).toBe('outerwear');
    expect(c.rows).toEqual([
      { label: 'M', measures: { chest: 110 } },
      { label: 'XL', measures: { shoulder: 48 } },
      { label: '175/88A', measures: { sleeve: 62.5 } },
    ]);
    expect(c.hwTable).toEqual([
      { label: 'M', weightMinKg: 54, weightMaxKg: 58 },
      { label: 'XL', weightMinKg: 60, weightMaxKg: 70 },
      { label: '175/88A', heightMin: 173, heightMax: 177 },
    ]);
  });
});

describe('inferCategory', () => {
  it.each([
    ['美式复古工装牛仔裤男', 'bottom'],
    ['老虎水洗短袖男日系T恤女', 'top'],
    ['加厚羽绒服', 'outerwear'],
    ['英伦风皮鞋男', 'shoe'],
    ['马丁靴', 'shoe'],
    ['露营椅子', 'other'],
  ])('%s → %s', (title, cat) => expect(inferCategory(title)).toBe(cat));
});

describe('parseProduct robustness', () => {
  it('returns an empty product for empty input without throwing', () => {
    const empty = { itemId: 'x', title: '', skuSizes: [], images: { main: [], sku: [], detail: [] }, shop: { extra: [] } };
    expect(parseProduct({}, 'x')).toEqual(empty);
    expect(parseProduct(null, 'x')).toEqual(empty);
    expect(parseProduct([], 'x')).toEqual(empty);
    expect(parseProduct('junk', 'x')).toEqual(empty);
  });

  it('keeps good subtrees when another is malformed', () => {
    const p = parseProduct({ item: { title: 'T', itemId: 5 }, seller: 'bad', skuBase: { props: 'bad' } }, 'x');
    expect(p.title).toBe('T');
    expect(p.itemId).toBe('x');
    expect(p.shop).toEqual({ extra: [] });
    expect(p.skuSizes).toEqual([]);
  });

  it('falls back to the displayed price range and vague sell count', () => {
    const p = parseProduct({
      item: { title: 'T', vagueSellCount: '1万+' },
      componentsVO: { priceVO: { price: { priceText: '¥129-159' }, extraPrice: { priceText: '99' } } },
    }, 'x');
    expect(p.price).toEqual({ min: 129, max: 159, coupon: 99 });
    expect(p.salesText).toBe('已售 1万+');
    expect(p.salesCount).toBe(10000);
  });

  it('leaves the discounted price unset when it is not below the list price', () => {
    const sku = (list: string, subPrice: string) => ({ price: { priceText: list }, subPrice: { priceText: subPrice } });
    const equal = parseProduct({ skuCore: { sku2info: { 0: sku('138', '138'), 1: sku('138', '138') } } }, 'x');
    expect(equal.price).toEqual({ min: 138, max: 138 });
    const higher = parseProduct({ componentsVO: { priceVO: { price: { priceText: '99' }, extraPrice: { priceText: '120' } } } }, 'x');
    expect(higher.price).toEqual({ min: 99, max: 99 });
  });
});

describe('parseSalesCount', () => {
  it.each([
    ['已售 1万+', 10000],
    ['月销 3000+', 3000],
    ['已售 512', 512],
    ['已售 10万+', 100000],
    ['已售 1.5万+', 15000],
  ])('%s → %d', (s, n) => expect(parseSalesCount(s)).toBe(n));

  it('returns undefined for text without a count', () => {
    expect(parseSalesCount('热卖中')).toBeUndefined();
  });
});

describe('parseReviews', () => {
  it('dedupes by id and drops empty and default texts', () => {
    const body = { data: { rateList: [
      { id: '1', feedback: '很好', skuValueStr: '黑色；L', feedbackDate: '2026年10月1日' },
      { id: '1', feedback: '很好' },
      { id: '2', feedback: '  ' },
      { id: '3', feedback: '此用户没有填写评价。' },
      { id: '4', feedback: '偏小' },
      { feedback: 'no id' },
    ] } };
    expect(parseReviews([body, 'junk', null])).toEqual([
      { id: '1', text: '很好', sku: '黑色；L', date: '2026年10月1日' },
      { id: '4', text: '偏小' },
    ]);
  });

  it('accepts numeric ids', () => {
    expect(parseReviews([{ data: { rateList: [{ id: 7, feedback: 'ok' }] } }])).toEqual([{ id: '7', text: 'ok' }]);
  });
});

describe('isCaptchaResponse', () => {
  it('detects captcha ret codes', () => {
    expect(isCaptchaResponse({ ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦'] })).toBe(true);
    expect(isCaptchaResponse({ ret: ['FAIL_SYS_USER_VALIDATE::请验证'] })).toBe(true);
  });

  it('is false for success and junk', () => {
    expect(isCaptchaResponse({ ret: ['SUCCESS::调用成功'] })).toBe(false);
    expect(isCaptchaResponse(null)).toBe(false);
    expect(isCaptchaResponse('RGV587_ERROR')).toBe(false);
  });
});

describe('images', () => {
  it('normalises protocol-relative URLs and strips thumbnail suffixes', () => {
    expect(normalizeImageUrl('//img.alicdn.com/imgextra/i1/a.jpg_60x60q90.jpg')).toBe('https://img.alicdn.com/imgextra/i1/a.jpg');
    expect(normalizeImageUrl('http://img.alicdn.com/a.png_.webp')).toBe('https://img.alicdn.com/a.png');
    expect(normalizeImageUrl('https://gw.alicdn.com/a.jpg')).toBe('https://gw.alicdn.com/a.jpg');
    expect(normalizeImageUrl('data:image/gif;base64,xx')).toBeNull();
  });

  it('extracts detail images from a getdesc body of any shape', () => {
    const body = { data: { components: { x: { text: '<img src="//img.alicdn.com/imgextra/i1/d1.jpg_400x400.jpg"><img src="https://img.alicdn.com/d2.png">' } },
      list: ['//img.alicdn.com/d1.jpg'] } };
    expect(parseDescImages([body])).toEqual(['https://img.alicdn.com/imgextra/i1/d1.jpg', 'https://img.alicdn.com/d2.png', 'https://img.alicdn.com/d1.jpg']);
  });
});
