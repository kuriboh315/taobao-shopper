import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoBuyerSecrets,
  buildExpected,
  buildFixtureSets,
  findBuyerSecrets,
  DEFAULT_API_PATTERNS,
  extractFromHar,
  extractSsrFromHtml,
  sanitizeReviews,
  sanitizeSsr,
} from '../../scripts/extract-fixtures';

const detailUrl =
  'https://h5api.m.taobao.com/h5/mtop.taobao.pcdetail.data.get/1.0/?jsv=2.7.2&appKey=12574478&t=1&sign=abc&data=%7B%7D';

const har = {
  log: {
    entries: [
      {
        request: {
          url: detailUrl,
          headers: [{ name: 'cookie', value: '_m_h5_tk=secret_123; other=1' }],
          cookies: [{ name: '_m_h5_tk', value: 'secret_123' }],
        },
        response: {
          content: { mimeType: 'text/javascript', text: 'mtopjsonp3({"ret":["SUCCESS::ok"],"data":{"title":"Tee"}})' },
        },
      },
      {
        request: { url: 'https://img.alicdn.com/imgextra/a.png', headers: [] },
        response: { content: { mimeType: 'image/png', text: 'xx' } },
      },
    ],
  },
};

describe('extractFromHar', () => {
  it('keeps only matching API responses, strips JSONP, and leaks no credentials', () => {
    const result = extractFromHar(har, DEFAULT_API_PATTERNS);
    expect(result).toHaveLength(1);
    expect(result[0]?.api).toBe('mtop.taobao.pcdetail.data.get');
    expect(result[0]?.body).toEqual({ ret: ['SUCCESS::ok'], data: { title: 'Tee' } });
    const json = JSON.stringify(result);
    expect(json).not.toContain('cookie');
    expect(json).not.toContain('_m_h5_tk');
    expect(json).not.toContain('sign=');
  });

  it('decodes base64 bodies and accepts plain JSON', () => {
    const body = Buffer.from('{"a":1}').toString('base64');
    const h = {
      log: { entries: [{ request: { url: detailUrl }, response: { content: { text: body, encoding: 'base64' } } }] },
    };
    expect(extractFromHar(h, DEFAULT_API_PATTERNS)[0]?.body).toEqual({ a: 1 });
  });

  it('skips entries with unparseable or missing bodies and rejects non-HAR input', () => {
    const h = {
      log: {
        entries: [
          { request: { url: detailUrl }, response: { content: { text: 'not json' } } },
          { request: { url: detailUrl }, response: { content: {} } },
        ],
      },
    };
    expect(extractFromHar(h, DEFAULT_API_PATTERNS)).toEqual([]);
    expect(() => extractFromHar({}, DEFAULT_API_PATTERNS)).toThrow();
  });
});

const res = {
  seller: { sellerNick: 'Shop {A}', userId: '123' },
  item: { itemId: '42', title: 'Tee', vagueSellCount: '300+' },
};

function pageWith(ctx: unknown): string {
  const json = JSON.stringify({ loaderData: { home: { data: { res: ctx } } }, renderMode: 'SSR' });
  return `<html><body><script>!(function () {var a = window.__ICE_APP_CONTEXT__ || {};var b = ${json};for (var k in a) {b[k] = a[k]}window.__ICE_APP_CONTEXT__=b;})();</script><script>if (window.__ICE_APP_CONTEXT__) { x(); }</script></body></html>`;
}

describe('extractSsrFromHtml', () => {
  it('returns loaderData.home.data.res, even with braces and quotes inside strings', () => {
    const tricky = { ...res, item: { ...res.item, title: 'a "quoted" } brace \ slash' } };
    expect(extractSsrFromHtml(pageWith(tricky))).toEqual(tricky);
  });

  it('throws a clear error when the context or res is missing', () => {
    expect(() => extractSsrFromHtml('<html></html>')).toThrow(/__ICE_APP_CONTEXT__/);
    expect(() => extractSsrFromHtml(pageWith(undefined).replace('"res"', '"other"'))).toThrow(/loaderData\.home\.data\.res/);
  });
});

describe('buildExpected', () => {
  it('summarises ssr and reviews', () => {
    const ssr = {
      seller: { evaluates: [{ type: 'desc', score: '4.7 ' }, { type: 'serv', score: '4.8 ' }] },
      item: { itemId: '42', title: 'Tee', vagueSellCount: '300+' },
      skuBase: {
        props: [
          { name: '颜色', values: [{ name: '黑' }] },
          {
            name: '尺码',
            values: [
              { name: 'S 98斤', sizeDescList: [{ key: '臀围', value: '110.0cm' }] },
              { name: 'M' },
            ],
          },
        ],
      },
      skuCore: { sku2info: { '0': { price: { priceMoney: '13800' } }, '1': { price: { priceMoney: '19850' } } } },
      componentsVO: { titleVO: { salesDesc: '已售 300+' } },
    };
    const reviews = [{ data: { rateList: [{ feedback: 'a' }, { feedback: 'b' }] } }, { data: { rateList: [{ feedback: 'c' }, { feedback: 'd' }] } }];
    expect(buildExpected(ssr, reviews)).toEqual({
      itemId: '42',
      title: 'Tee',
      skuSizes: ['S 98斤', 'M'],
      priceMin: 138,
      priceMax: 198.5,
      sales: '已售 300+',
      sellerDsr: { desc: 4.7, serv: 4.8 },
      firstReviews: ['a', 'b', 'c'],
      sizeDescList: { 'S 98斤': { 臀围: '110.0cm' } },
    });
  });

  it('omits sizes and size descriptions for non-size items', () => {
    const e = buildExpected({ item: { itemId: '1', title: 'T' }, skuBase: { props: [] }, skuCore: { sku2info: {} } }, []);
    expect(e.skuSizes).toEqual([]);
    expect(e.sizeDescList).toBeUndefined();
    expect(e.firstReviews).toEqual([]);
  });
});


describe('buildExpected discounts', () => {
  it('reports the lowest subPrice as priceDiscount', () => {
    const e = buildExpected(
      { skuCore: { sku2info: { '0': { price: { priceMoney: '13800' }, subPrice: { priceMoney: '11700' } }, '1': { price: { priceMoney: '13800' } } } } },
      [],
    );
    expect(e.priceDiscount).toBe(117);
    expect(e.priceMin).toBe(138);
  });
});

describe('sanitizeReviews (allowlist)', () => {
  it('keeps only text, sku label, date, ids and counts, and drops pictures, share, reply and user fields', () => {
    const body = {
      api: 'mtop.taobao.rate.detaillist.get',
      ret: ['SUCCESS::ok'],
      data: {
        feedAllCount: '10',
        feedGoodCount: '9',
        userType: 'x',
        extraInfo: { newUserTag: 'y' },
        rateList: [
          {
            id: '1',
            feedback: '很好',
            skuValueStr: '尺码:M',
            feedbackDate: '2026年1月1日',
            rateType: '1',
            auctionNumId: '42',
            userNick: 'secret',
            userId: '9',
            feedPicList: [{ thumbnail: 'https://x/imgextra/i3/123456789/a.jpg' }],
            share: { shareCover: 'c' },
            reply: 'r',
            someFutureUserField: 'z',
          },
        ],
      },
    };
    const out = sanitizeReviews(body) as { data: { rateList: Record<string, unknown>[] } };
    expect(Object.keys(out.data.rateList[0] ?? {}).sort()).toEqual(
      ['auctionNumId', 'feedback', 'feedbackDate', 'id', 'rateType', 'skuValueStr'],
    );
    expect(out).toEqual({
      api: 'mtop.taobao.rate.detaillist.get',
      ret: ['SUCCESS::ok'],
      data: { feedAllCount: '10', feedGoodCount: '9', rateList: [{ id: '1', feedback: '很好', skuValueStr: '尺码:M', feedbackDate: '2026年1月1日', rateType: '1', auctionNumId: '42' }] },
    });
  });

  it('passes through bodies without a rateList', () => {
    expect(sanitizeReviews({ ret: ['FAIL'] })).toEqual({ ret: ['FAIL'] });
  });
});

describe('sanitizeSsr (allowlist)', () => {
  const input = {
    seller: { sellerNick: 'S', userId: '123', shopName: 'Shop', secretField: 'x' },
    item: { itemId: '42', title: 'Tee', images: ['https://a/1.jpg'], extra: 'drop' },
    skuBase: { props: [{ name: '尺码' }], skus: [], other: 1 },
    skuCore: {
      sku2info: {
        '0': {
          price: { priceText: '138', priceMoney: '13800', priceColor: '#fff' },
          subPrice: { priceText: '117', priceMoney: '11700', priceColor: '#000' },
          quantity: 200,
          logisticsTime: '明天送达',
          buyExParams: { mi_id: 'tok' },
        },
      },
    },
    plusViewVO: { industryParamVO: { hit: 'true' }, askAnswerVO: { hit: 'true' } },
    pcTrade: { pcCartParam: { areaId: '1', addressId: '2' } },
    componentsVO: {
      priceVO: { price: { priceText: '138' } },
      titleVO: { salesDesc: '已售 300+', other: 'drop' },
      deliveryVO: { deliveryToAddr: 'somewhere', deliverToCity: 'c' },
      rateVO: { group: { items: [{ userName: 'n', headPic: 'https://sns/avatar?userFlag=abc' }] } },
      sizeTableVO: {
        sizeTableTaoDetailView: {
          datas: {
            args: { user_id: '999' },
            sizeRecommend: { titleTail: 'M' },
            tabConfiguration: { global: { userClickUrl: 'https://u' } },
            sizeData: {
              userSize: { data: [{ avatar: 'a' }] },
              heightTable: { code: 'heightTable', data: [[{ text: '170' }]] },
              sizeTable: { code: 'sizeTable', data: [[{ text: 'S' }]] },
            },
          },
        },
      },
    },
  };

  it('copies only allowlisted subtrees', () => {
    expect(sanitizeSsr(input)).toEqual({
      seller: { sellerNick: 'S', userId: '123', shopName: 'Shop' },
      item: { itemId: '42', title: 'Tee', images: ['https://a/1.jpg'] },
      skuBase: { props: [{ name: '尺码' }], skus: [] },
      skuCore: {
        sku2info: {
          '0': {
            price: { priceText: '138', priceMoney: '13800' },
            subPrice: { priceText: '117', priceMoney: '11700' },
            quantity: 200,
          },
        },
      },
      plusViewVO: { industryParamVO: { hit: 'true' } },
      componentsVO: {
        priceVO: { price: { priceText: '138' } },
        titleVO: { salesDesc: '已售 300+' },
        sizeTableVO: {
          sizeTableTaoDetailView: {
            datas: {
              sizeData: {
                heightTable: { code: 'heightTable', data: [[{ text: '170' }]] },
                sizeTable: { code: 'sizeTable', data: [[{ text: 'S' }]] },
              },
            },
          },
        },
      },
    });
  });

  it('strips identity URLs even inside kept subtrees', () => {
    const out = sanitizeSsr({
      item: { title: 'T', images: ['https://a/1.jpg', 'https://sns/x?userFlag=abc', 'https://b/?uid=5'], spuId: 'https://c/?userId=7' },
    });
    expect(out).toEqual({ item: { title: 'T', images: ['https://a/1.jpg'] }, seller: {}, skuBase: {}, skuCore: { sku2info: {} }, plusViewVO: {}, componentsVO: { titleVO: {} } });
  });
});

describe('buyer identifier guard', () => {
  const html =
    '<script>window.__itempage_userinfo = {"userId":1234567890123,"userNumId":1234567890123,"nick":"tb1234567890123","displayNick":"tb1234567890123"};</script>' +
    '<script>x = {"user_id": "9876543210987"}</script>';

  it('collects ids from __itempage_userinfo and user_id values', () => {
    expect(findBuyerSecrets(html).sort()).toEqual(['1234567890123', '9876543210987', 'tb1234567890123'].sort());
  });

  it('refuses to continue when no buyer id can be located', () => {
    expect(() => findBuyerSecrets('<html>nothing here</html>')).toThrow(/buyer id/);
    expect(() => findBuyerSecrets('<script>window.__itempage_userinfo = {broken</script>')).toThrow(/buyer id/);
  });

  it('throws without echoing the id when an output contains it, and passes clean output', () => {
    const secrets = findBuyerSecrets(html);
    expect(() => assertNoBuyerSecrets(['{"a":"clean"}', '{"x":"v9876543210987"}'], secrets)).toThrow(/leaked/);
    let message = '';
    try {
      assertNoBuyerSecrets(['9876543210987'], secrets);
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/leaked/);
    expect(message).not.toContain('9876543210987');
    expect(() => assertNoBuyerSecrets(['{"a":"clean"}'], secrets)).not.toThrow();
  });
});

describe('buildFixtureSets', () => {
  const ctx = { loaderData: { home: { data: { res: { item: { itemId: '42', title: 'Tee' } } } } } };
  const page = (secretInTitle: boolean): string =>
    `<script>window.__itempage_userinfo = {"userId":1234567890123};</script><script>!(function () {var a = window.__ICE_APP_CONTEXT__ || {};var b = ${JSON.stringify(ctx).replace('Tee', secretInTitle ? 'T1234567890123' : 'Tee')};window.__ICE_APP_CONTEXT__=b;})();</script>`;
  const har = { log: { entries: [] } };

  function setup(html: string): { raw: string; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'));
    const raw = join(dir, 'raw');
    mkdirSync(raw);
    writeFileSync(join(raw, 'x.har'), JSON.stringify(har));
    writeFileSync(join(raw, 'x.html'), html);
    return { raw, out: join(dir, 'out') };
  }

  it('writes ssr, reviews and expected for each har+html pair', () => {
    const { raw, out } = setup(page(false));
    expect(buildFixtureSets(raw, out)).toEqual(['x']);
    expect(readdirSync(join(out, 'x')).sort()).toEqual(['expected.json', 'reviews.json', 'ssr.json']);
  });

  it('writes nothing when a buyer id would leak', () => {
    const { raw, out } = setup(page(true));
    expect(() => buildFixtureSets(raw, out)).toThrow(/leaked/);
    expect(existsSync(out)).toBe(false);
  });
});
