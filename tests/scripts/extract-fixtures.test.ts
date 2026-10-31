import { describe, expect, it } from 'vitest';
import { DEFAULT_API_PATTERNS, extractFromHar } from '../../scripts/extract-fixtures';

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
