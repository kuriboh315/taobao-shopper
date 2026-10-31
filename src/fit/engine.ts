import { garmentFor, targets } from './ease';
import { recommendShoe } from './fallbacks';
import { KEY_ORDER, detailFor, isLengthKey, isWidthKey, noteFor } from './notes';
import type { Body, ChartRow, FitResult, MeasureKey, Profile, SizeChart, SizeFit } from '../shared/types';

type Measures = Partial<Record<MeasureKey, number>>;

const weight = (k: MeasureKey): number => (k === 'chest' || k === 'waist' ? 1.5 : isLengthKey(k) ? 0.7 : 1.0);
const penalty = (d: number): number => (d < 0 ? 1.5 * Math.abs(d) : Math.abs(d));

/** Weighted sum of penalties over keys present in both; null when no key overlaps. */
export function scoreRow(measures: Measures, t: Measures): number | null {
  let score = 0;
  let overlap = false;
  for (const k of KEY_ORDER) {
    const v = measures[k];
    const tv = t[k];
    if (v === undefined || tv === undefined) continue;
    overlap = true;
    score += weight(k) * penalty(v - tv);
  }
  return overlap ? score : null;
}

/** 'other' charts: no recommendation. (Shoes go through recommendShoe in fallbacks.ts.) */
function recommendUnsupported(chart: SizeChart): FitResult {
  return {
    basis: 'none', recommended: null, comparedAgainst: '',
    sizes: chart.rows.map(r => ({ label: r.label, measures: r.measures, deltas: {}, note: '—', detail: [] })),
  };
}

const primaryKey = (cat: SizeChart['category']): MeasureKey => (cat === 'bottom' ? 'waist' : 'chest');

function describeAgainst(profile: Profile, cat: SizeChart['category']): string {
  const main: MeasureKey[] = [primaryKey(cat), cat === 'bottom' ? 'inseam' : 'length'];
  const body = main.filter(k => typeof profile.body[k as keyof Body] === 'number')
    .map(k => `${k} ${profile.body[k as keyof Body]}`);
  const g = garmentFor(profile, cat);
  const gm = g ? main.filter(k => g.measures[k as keyof typeof g.measures]).map(k => `${k} ${g.measures[k as keyof typeof g.measures]!.value}`) : [];
  const parts: string[] = [];
  if (body.length) parts.push(`your body (${body.join(', ')})`);
  if (g && gm.length) parts.push(`your ${g.label} (${gm.join(', ')})`);
  return parts.length ? `vs ${parts.join(' and ')}` : '';
}

export function recommend(chart: SizeChart, profile: Profile): FitResult {
  const cat = chart.category;
  if (cat === 'shoe') return recommendShoe(chart, profile);
  if (cat !== 'top' && cat !== 'outerwear' && cat !== 'bottom') return recommendUnsupported(chart);

  const { basis, t } = targets(profile, cat);
  const garment = garmentFor(profile, cat);
  const pk = primaryKey(cat);
  const gPrimary = garment?.measures[pk as keyof typeof garment.measures];
  const bodyPrimary = profile.body[pk as keyof Body];
  const body = typeof bodyPrimary === 'number' ? bodyPrimary : undefined;

  let best = -1;
  let bestScore = Infinity;
  chart.rows.forEach((row, i) => {
    const s = basis === 'none' ? null : scoreRow(row.measures, t);
    if (s !== null && s <= bestScore) { best = i; bestScore = s; } // ties go to the later (larger) row
  });

  const sizes: SizeFit[] = chart.rows.map((row: ChartRow) => {
    const deltas: Measures = {};
    for (const k of KEY_ORDER) {
      if (row.measures[k] !== undefined && t[k] !== undefined) deltas[k] = row.measures[k]! - t[k]!;
    }
    const parts = KEY_ORDER
      .filter(k => row.measures[k] !== undefined && (k === pk || isLengthKey(k)))
      .map(k => noteFor(k, row.measures[k]!, t[k], k === pk && isWidthKey(k) ? { body, garment: gPrimary } : {}))
      .filter(Boolean);
    const detail = detailFor(row.measures, t, { body: profile.body, garment });
    return { label: row.label, measures: row.measures, deltas, note: parts.length ? parts.join(', ') : '—', detail };
  });

  return {
    basis, sizes,
    recommended: best >= 0 ? chart.rows[best]!.label : null,
    comparedAgainst: basis === 'none' ? '' : describeAgainst(profile, cat),
  };
}
