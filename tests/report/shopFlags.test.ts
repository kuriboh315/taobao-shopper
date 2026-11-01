import { describe, it, expect } from 'vitest';
import { shopFlags } from '../../src/report/shopFlags';
import type { ProductData } from '../../src/shared/types';

const product = (shop: ProductData['shop'], extra: Partial<ProductData> = {}): ProductData =>
  ({ itemId: '1', title: 't', skuSizes: [], shop, images: { main: [], sku: [], detail: [] }, ...extra });

describe('shopFlags', () => {
  it('flags low DSR and young shop', () => {
    const flags = shopFlags(product({ dsr: { description: 4.5, service: 4.8 }, ageYears: 0.4, extra: [] }));
    expect(flags).toHaveLength(2);
    expect(flags[0]).toEqual({ group: 'shop', text: 'Low description rating (4.5)', source: 'shop page' });
    expect(flags[1]!.text).toBe('Shop opened 5 months ago');
  });
  it('flags few sales', () => {
    const flags = shopFlags(product({ extra: [] }, { salesCount: 42 }));
    expect(flags.map(f => f.text)).toEqual(['Few sales (42)']);
  });
  it('flags nothing for a healthy shop', () => {
    expect(shopFlags(product({ dsr: { description: 4.8, service: 4.6, shipping: 4.9 }, ageYears: 3, extra: [] }, { salesCount: 100 }))).toEqual([]);
  });
});
