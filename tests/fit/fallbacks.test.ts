import { describe, it, expect } from 'vitest';
import { recommendShoe, pickFromHwTable, nearbyReviewers } from '../../src/fit/fallbacks';
import { recommend } from '../../src/fit/engine';
import { DEFAULT_PROFILE as P } from '../../src/shared/schemas';
import type { HwRow, Profile, ReviewLabel, SizeChart } from '../../src/shared/types';

const shoeChart: SizeChart = {
  found: true, category: 'shoe', hwTable: [],
  rows: [
    { label: '40', measures: { footLength: 25.5 } },
    { label: '41', measures: { footLength: 26 } },
    { label: '42', measures: { footLength: 26.5 } },
  ],
};
const withBody = (body: Profile['body'], extra: Partial<Profile> = {}): Profile =>
  ({ ...P, body, prefs: { ...P.prefs, shoe: 'true_to_size' }, ...extra });

describe('recommendShoe', () => {
  it('picks smallest row >= foot + allowance', () => {
    const r = recommendShoe(shoeChart, withBody({ footLength: 25.5 }));
    expect(r.basis).toBe('shoe');
    expect(r.recommended).toBe('42');
    expect(r.sizes.find(s => s.label === '42')!.note).toBe('+1 cm room');
    expect(r.sizes).toHaveLength(3);
  });
  it('formats fractional room with one decimal', () => {
    const r = recommendShoe(shoeChart, withBody({ footLength: 25.2 }, { prefs: { ...P.prefs, shoe: 'fitted' } }));
    expect(r.recommended).toBe('41');
    expect(r.sizes.find(s => s.label === '41')!.note).toBe('+0.8 cm room');
  });
  it('falls back to usual EU size when no foot length', () => {
    const r = recommendShoe(shoeChart, withBody({ shoeSizeEU: 42 }));
    expect(r.recommended).toBe('42');
    expect(r.sizes.find(s => s.label === '42')!.note).toBe('your usual size');
  });
  it('uses shoe ref size when body has none', () => {
    const r = recommendShoe(shoeChart, withBody({}, { shoe: { label: 'AF1', sizeCN: 41 } }));
    expect(r.recommended).toBe('41');
  });
  it('returns null with nothing to go on', () => {
    expect(recommendShoe(shoeChart, withBody({})).recommended).toBeNull();
  });
  it('is wired into recommend', () => {
    expect(recommend(shoeChart, withBody({ footLength: 25.5 })).recommended).toBe('42');
  });
});

describe('pickFromHwTable', () => {
  const hw: HwRow[] = [
    { label: 'M', heightMin: 165, heightMax: 175, weightMinKg: 55, weightMaxKg: 65 },
    { label: 'L', heightMin: 170, heightMax: 180, weightMinKg: 60, weightMaxKg: 70 },
  ];
  it('prefers a row containing both', () => {
    expect(pickFromHwTable(hw, { heightCm: 175, weightKg: 68 })).toBe('L');
  });
  it('picks the larger row when several contain both', () => {
    expect(pickFromHwTable(hw, { heightCm: 175, weightKg: 62 })).toBe('L');
  });
  it('matches on the one present', () => {
    expect(pickFromHwTable(hw, { weightKg: 56 })).toBe('M');
    expect(pickFromHwTable(hw, { heightCm: 166 })).toBe('M');
  });
  it('with one each, picks the last matching weight', () => {
    const t: HwRow[] = [
      { label: 'S', heightMin: 150, heightMax: 160, weightMinKg: 40, weightMaxKg: 50 },
      { label: 'M', heightMin: 161, heightMax: 170, weightMinKg: 51, weightMaxKg: 60 },
      { label: 'L', heightMin: 171, heightMax: 180, weightMinKg: 61, weightMaxKg: 70 },
    ];
    expect(pickFromHwTable(t, { heightCm: 165, weightKg: 65 })).toBe('L');
  });
  it('returns null with no height or weight, or no match', () => {
    expect(pickFromHwTable(hw, {})).toBeNull();
    expect(pickFromHwTable(hw, { heightCm: 200, weightKg: 100 })).toBeNull();
  });
});

describe('nearbyReviewers', () => {
  const l = (o: Partial<ReviewLabel>): ReviewLabel => ({ idx: 0, sentiment: 'pos', sizing: null, ...o });
  it('drops labels missing weight and groups by size', () => {
    const labels = [
      l({ heightCm: 175, weightKg: 68, sizeBought: 'XL', sizing: 'runs_small' }),
      l({ heightCm: 176, weightKg: 66, sizeBought: 'XL', sizing: 'true_to_size' }),
      l({ heightCm: 174, weightKg: 70, sizeBought: 'L', sizing: 'runs_large' }),
      l({ heightCm: 175, sizeBought: 'M' }),
      l({ heightCm: 190, weightKg: 68, sizeBought: 'XXL' }),
    ];
    const out = nearbyReviewers(labels, { heightCm: 175, weightKg: 68 });
    expect(out.map(o => [o.sizeBought, o.count])).toEqual([['XL', 2], ['L', 1]]);
    expect(out[0]!.sizing).toEqual({ runs_small: 1, runs_large: 0, true_to_size: 1 });
  });
});
