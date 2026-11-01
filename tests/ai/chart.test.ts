import { describe, it, expect, vi } from 'vitest';
import { normalizeChart, readSizeChart } from '../../src/ai/chart';
import type { ChartDeps } from '../../src/ai/chart';
import type { Tile } from '../../src/ai/images';
import type { ProductData, Settings } from '../../src/shared/types';

const row = (label: string, measures: unknown[]) => ({ label, measures });
const m = (key: string | null, value: number, basis = 'circumference') => ({ name_zh: 'x', key, value, basis });

describe('normalizeChart', () => {
  const base = { found: true, unit: 'cm', hw: [] };

  it('doubles a flat chest', () => {
    const c = normalizeChart({ ...base, rows: [row('M', [m('chest', 60, 'flat')])] }, []);
    expect(c.rows[0]!.measures.chest).toBe(120);
  });

  it('converts inches to cm, rounded to 0.5', () => {
    const c = normalizeChart({ ...base, unit: 'inch', rows: [row('M', [m('chest', 47)])] }, []);
    expect(c.rows[0]!.measures.chest).toBe(119.5);
  });

  it('converts mm to cm', () => {
    const c = normalizeChart({ ...base, unit: 'mm', rows: [row('M', [m('chest', 1100)])] }, []);
    expect(c.rows[0]!.measures.chest).toBe(110);
  });

  it('converts jin to kg', () => {
    const c = normalizeChart(
      { ...base, rows: [], hw: [{ label: 'M', heightMin: 165, heightMax: 170, weightMin: 130, weightMax: 150, weightUnit: 'jin' }] },
      [],
    );
    expect(c.hwTable).toEqual([
      { label: 'M', heightMin: 165, heightMax: 170, weightMinKg: 65, weightMaxKg: 75 },
    ]);
  });

  it('is not found for an hw-only chart but still returns the hwTable in kg', () => {
    const c = normalizeChart(
      { found: true, unit: 'cm', rows: [], hw: [{ label: 'M', heightMin: 165, heightMax: 170, weightMin: 130, weightMax: 150, weightUnit: 'jin' }] },
      [],
    );
    expect(c.found).toBe(false);
    expect(c.rows).toEqual([]);
    expect(c.hwTable).toEqual([{ label: 'M', heightMin: 165, heightMax: 170, weightMinKg: 65, weightMaxKg: 75 }]);
  });

  it('drops a negative measure but keeps the rest of the row', () => {
    const c = normalizeChart({ ...base, rows: [row('M', [m('chest', -3), m('length', 70)])] }, []);
    expect(c.rows[0]!.measures).toEqual({ length: 70 });
  });

  it('drops null-key measures and out-of-range values', () => {
    const c = normalizeChart(
      { ...base, rows: [row('M', [m(null, 50), m('length', 400), m('sleeve', 60)])] },
      [],
    );
    expect(c.rows[0]!.measures).toEqual({ sleeve: 60 });
  });

  it('doubles a circumference-labelled chest under 70 and waist under 50', () => {
    const c = normalizeChart({ ...base, rows: [row('M', [m('chest', 55), m('waist', 40)])] }, []);
    expect(c.rows[0]!.measures).toEqual({ chest: 110, waist: 80 });
  });

  it('drops a row with an empty label', () => {
    const c = normalizeChart({ ...base, rows: [row('  ', [m('chest', 100)]), row('L', [m('chest', 104)])] }, []);
    expect(c.rows.map((r) => r.label)).toEqual(['L']);
  });

  it('is not found when every row is invalid', () => {
    const c = normalizeChart({ ...base, rows: [row('M', [m('chest', -3)]), row('', [m('chest', 100)])] }, []);
    expect(c.found).toBe(false);
    expect(c.rows).toEqual([]);
  });

  it('is not found when the model says so', () => {
    const c = normalizeChart({ found: false, unit: 'cm', rows: [], hw: [] }, []);
    expect(c.found).toBe(false);
  });

  it('is not found for malformed output', () => {
    expect(normalizeChart({ nonsense: 1 }, []).found).toBe(false);
  });

  it('orders rows by the SKU size order where labels match', () => {
    const c = normalizeChart(
      { ...base, rows: [row('L', [m('chest', 110)]), row('X', [m('chest', 90)]), row('M码', [m('chest', 100)])] },
      ['M', 'L'],
    );
    expect(c.rows.map((r) => r.label)).toEqual(['M码', 'L', 'X']);
  });
});

describe('readSizeChart', () => {
  const settings: Settings = { apiKey: 'k', model: 'claude-sonnet-5-5' };
  const product: ProductData = {
    itemId: '1',
    title: 'tee',
    skuSizes: ['M', 'L'],
    sizeGuideText: 'guide',
    shop: { extra: [] },
    images: { main: ['m'], sku: ['s'], detail: ['d1', 'd2'] },
  };

  const fakeFetch = vi.fn(async (urls: string[], opts: { maxEdge: number; maxTiles: number }) => {
    const out: Tile[] = [];
    for (let index = 0; index < urls.length; index++) {
      for (let tile = 0; tile < 5 && out.length < opts.maxTiles; tile++) {
        out.push({ src: urls[index]!, index, tile, media_type: 'image/jpeg', data: `${urls[index]}-${tile}-${opts.maxEdge}` });
      }
    }
    return out;
  });

  const imageCount = (content: { type: string }[]) => content.filter((b) => b.type === 'image').length;

  it('skips pass 2 when pass 1 finds no tiles', async () => {
    const call = vi.fn(async () => ({ tiles: [], category: 'top' }));
    const chart = await readSizeChart(product, settings, () => {}, { call, fetchTiles: fakeFetch } as unknown as ChartDeps);
    expect(call).toHaveBeenCalledTimes(1);
    expect(chart).toEqual({ found: false, category: 'top', rows: [], hwTable: [] });
  });

  it('sends only the located tiles, re-fetched at 1568, in pass 2', async () => {
    const calls: { tool: { name: string }; content: { type: string }[] }[] = [];
    const call = vi.fn(async (args: { tool: { name: string }; content: { type: string }[] }) => {
      calls.push(args);
      if (args.tool.name === 'locate_size_chart') return { tiles: [3, 4], category: 'top' };
      return { found: true, unit: 'cm', rows: [row('M', [m('chest', 100)])], hw: [] };
    });
    const chart = await readSizeChart(product, settings, () => {}, { call, fetchTiles: fakeFetch } as unknown as ChartDeps);
    expect(call).toHaveBeenCalledTimes(2);
    expect(imageCount(calls[1]!.content)).toBe(2);
    expect(JSON.stringify(calls[1]!.content)).toContain('d1-3-1568');
    expect(JSON.stringify(calls[1]!.content)).toContain('d1-4-1568');
    expect(chart.found).toBe(true);
    expect(chart.category).toBe('top');
    expect(chart.rows[0]!.measures.chest).toBe(100);
  });

  it('caps pass 2 at 6 tiles and ignores out-of-range indices', async () => {
    const calls: { tool: { name: string }; content: { type: string }[] }[] = [];
    const call = vi.fn(async (args: { tool: { name: string }; content: { type: string }[] }) => {
      calls.push(args);
      if (args.tool.name === 'locate_size_chart') return { tiles: [0, 1, 2, 3, 4, 5, 6, 7, 999, -1], category: 'bottom' };
      return { found: false, unit: 'cm', rows: [], hw: [] };
    });
    await readSizeChart(product, settings, () => {}, { call, fetchTiles: fakeFetch } as unknown as ChartDeps);
    expect(imageCount(calls[1]!.content)).toBe(6);
  });
});
