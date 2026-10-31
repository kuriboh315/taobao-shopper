import { describe, it, expect } from 'vitest';
import { recommend, scoreRow } from '../../src/fit/engine';
import { targets } from '../../src/fit/ease';
import { DEFAULT_PROFILE as P } from '../../src/shared/schemas';
import type { RefGarment, SizeChart, Profile } from '../../src/shared/types';

const hoodie: RefGarment = { label: 'hoodie', measures: { chest: { value: 120, tag: 'relaxed' }, length: { value: 71, tag: 'just_right' }, sleeve: { value: 62, tag: 'slightly_long' } } };
const chart: SizeChart = {
  found: true, category: 'top', hwTable: [],
  rows: [
    { label: 'L', measures: { chest: 116, length: 70, sleeve: 60 } },
    { label: 'XL', measures: { chest: 122, length: 72, sleeve: 62 } },
    { label: 'XXL', measures: { chest: 128, length: 74, sleeve: 63 } },
  ],
};
const profile = (pref: 'slightly_relaxed' | 'oversized'): Profile =>
  ({ ...P, body: { chest: 108 }, garments: { top: hoodie }, prefs: { ...P.prefs, top: pref } });

describe('recommend', () => {
  it('slightly_relaxed → XL', () => expect(recommend(chart, profile('slightly_relaxed')).recommended).toBe('XL'));
  it('oversized → XXL', () => expect(recommend(chart, profile('oversized')).recommended).toBe('XXL'));
  it('keeps chart order and basis', () => {
    const r = recommend(chart, profile('slightly_relaxed'));
    expect(r.sizes.map(s => s.label)).toEqual(['L', 'XL', 'XXL']);
    expect(r.basis).toBe('garment');
  });
  it('scores follow the weighted asymmetric penalty', () => {
    const p = profile('slightly_relaxed');
    const { t } = targets(p, 'top');
    expect(scoreRow(chart.rows[0]!.measures, t)).toBeCloseTo(10.05, 5);
    expect(scoreRow(chart.rows[1]!.measures, t)).toBeCloseTo(5.1, 5);
    expect(scoreRow(chart.rows[1]!.measures, t)!).toBeLessThan(scoreRow(chart.rows[0]!.measures, t)!);
  });
  it('notes for slightly_relaxed', () => {
    const r = recommend(chart, profile('slightly_relaxed'));
    expect(r.sizes[0]!.note).toBe('Regular');
    expect(r.sizes[1]!.note).toBe('Relaxed');
    expect(r.sizes[2]!.note).toBe('Oversized, length +3, sleeves +3');
  });
  it('deltas are row minus target', () => {
    const r = recommend(chart, profile('slightly_relaxed'));
    expect(r.sizes[1]!.deltas).toEqual({ chest: 2, length: 1, sleeve: 2 });
  });
  it('comparedAgainst names body and garment', () =>
    expect(recommend(chart, profile('slightly_relaxed')).comparedAgainst)
      .toBe('vs your body (chest 108) and your hoodie (chest 120, length 71)'));
  it('comparedAgainst body only / garment only', () => {
    expect(recommend(chart, { ...P, body: { chest: 108 } }).comparedAgainst).toBe('vs your body (chest 108)');
    expect(recommend(chart, { ...P, garments: { top: hoodie } }).comparedAgainst).toBe('vs your hoodie (chest 120, length 71)');
  });
  it('detail lines only on the recommended size', () => {
    const r = recommend(chart, profile('slightly_relaxed'));
    expect(r.sizes[0]!.detail).toEqual([]);
    expect(r.sizes[1]!.detail).toEqual([
      'chest 2 cm roomier than your hoodie (relaxed)',
      'length same as your hoodie',
      'sleeves same as your hoodie (which you find slightly long)',
    ]);
  });
  it('body-only detail', () => {
    const r = recommend(chart, { ...P, body: { chest: 108 }, prefs: { ...P.prefs, top: 'slightly_relaxed' } });
    expect(r.recommended).toBe('XL');
    expect(r.sizes[1]!.detail).toEqual(['chest +14 cm vs your body']);
  });
  it('tie → later row wins', () => {
    const c: SizeChart = { ...chart, rows: [{ label: 'M', measures: { chest: 110 } }, { label: 'L', measures: { chest: 130 } }] };
    const p: Profile = { ...P, prefs: { ...P.prefs, top: 'slightly_relaxed' }, garments: { top: { label: 'x', measures: { chest: { value: 120, tag: 'relaxed' } } } } };
    expect(recommend(c, p).recommended).toBe('L');
  });
  it('partial profile → null, dash notes, no throw', () => {
    const r = recommend(chart, { ...P, body: { waist: 80 } });
    expect(r.recommended).toBeNull();
    expect(r.sizes.map(s => s.note)).toEqual(['—', '—', '—']);
  });
  it('single row 均码 with only body chest → Very baggy', () => {
    const c: SizeChart = { ...chart, rows: [{ label: '均码', measures: { chest: 140 } }] };
    const r = recommend(c, { ...P, body: { chest: 108 } });
    expect(r.recommended).toBe('均码');
    expect(r.sizes[0]!.note).toBe('Very baggy');
  });
  it('bottom uses waist as primary', () => {
    const c: SizeChart = { found: true, category: 'bottom', hwTable: [], rows: [{ label: '30', measures: { waist: 80, inseam: 80 } }] };
    const r = recommend(c, { ...P, body: { waist: 76, inseam: 76 } });
    expect(r.sizes[0]!.note).toBe('Relaxed, inseam +4');
  });
  it('shoe and other → no recommendation (swap point for Task 5)', () => {
    const c: SizeChart = { found: true, category: 'shoe', hwTable: [], rows: [{ label: '42', measures: { footLength: 26 } }] };
    expect(recommend(c, P)).toEqual({
      basis: 'none', recommended: null, comparedAgainst: '',
      sizes: [{ label: '42', measures: { footLength: 26 }, deltas: {}, note: '—', detail: [] }],
    });
  });
});
