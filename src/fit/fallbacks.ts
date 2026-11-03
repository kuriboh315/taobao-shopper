import { normalizeSizeLabel } from '../shared/sizeLabel';
import type { Body, FitPref, FitResult, HwRow, Profile, ReviewLabel, SizeChart, SizeFit, Sizing } from '../shared/types';

/** Extra foot-length room in cm wanted on top of the foot, by preference. */
const SHOE_ALLOWANCE: Record<FitPref, number> = { fitted: 0.5, true_to_size: 0.8, slightly_relaxed: 1.0, oversized: 1.5 };
const EPS = 1e-9;

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

function usualSizes(profile: Profile): number[] {
  return [profile.body.shoeSizeEU, profile.body.shoeSizeCN, profile.shoe?.sizeEU, profile.shoe?.sizeCN]
    .filter((v): v is number => typeof v === 'number');
}

export function recommendShoe(chart: SizeChart, profile: Profile): FitResult {
  const foot = profile.body.footLength;
  const blank = (r: { label: string; measures: SizeFit['measures'] }): SizeFit =>
    ({ label: r.label, measures: r.measures, deltas: {}, note: '—', detail: [] });

  if (typeof foot === 'number') {
    const need = foot + SHOE_ALLOWANCE[profile.prefs.shoe];
    let best: string | null = null;
    let bestLen = Infinity;
    const sizes: SizeFit[] = chart.rows.map(row => {
      const len = row.measures.footLength;
      if (len === undefined) return blank(row);
      if (len >= need - EPS && len < bestLen) { best = row.label; bestLen = len; }
      const room = len - foot;
      return { ...blank(row), deltas: { footLength: room }, note: `${room < 0 ? '' : '+'}${fmt(room)} cm room` };
    });
    if (sizes.some(s => s.measures.footLength !== undefined)) {
      return { basis: 'shoe', recommended: best, sizes, comparedAgainst: `vs your foot length ${foot} cm` };
    }
  }

  for (const size of usualSizes(profile)) {
    const want = normalizeSizeLabel(String(size));
    const hit = chart.rows.find(r => normalizeSizeLabel(r.label) === want);
    if (!hit) continue;
    return {
      basis: 'shoe', recommended: hit.label, comparedAgainst: `vs your usual size ${size}`,
      sizes: chart.rows.map(r => (r === hit ? { ...blank(r), note: 'your usual size' } : blank(r))),
    };
  }

  return { basis: 'none', recommended: null, comparedAgainst: '', sizes: chart.rows.map(blank) };
}

const inRange = (v: number, min?: number, max?: number): boolean =>
  (min !== undefined || max !== undefined) && v >= (min ?? -Infinity) && v <= (max ?? Infinity);

/** Size from a height/weight table; ties go to the later (larger) row. */
export function pickFromHwTable(hw: HwRow[], body: Body): string | null {
  const { heightCm: h, weightKg: w } = body;
  const byH = (r: HwRow) => h !== undefined && inRange(h, r.heightMin, r.heightMax);
  const byW = (r: HwRow) => w !== undefined && inRange(w, r.weightMinKg, r.weightMaxKg);
  const last = (pred: (r: HwRow) => boolean): string | null => hw.filter(pred).at(-1)?.label ?? null;

  if (h === undefined && w === undefined) return null;
  if (h !== undefined && w !== undefined) return last(r => byH(r) && byW(r)) ?? last(byW) ?? last(byH);
  return last(h !== undefined ? byH : byW);
}

/** Reviewers within 3 cm / 3 kg of the body, grouped by size bought (most common first). */
export function nearbyReviewers(labels: ReviewLabel[], body: Body):
  { sizeBought: string; count: number; sizing: Record<Sizing, number> }[] {
  const { heightCm: h, weightKg: w } = body;
  if (h === undefined || w === undefined) return [];
  const groups = new Map<string, { sizeBought: string; count: number; sizing: Record<Sizing, number> }>();
  for (const l of labels) {
    if (l.heightCm === undefined || l.weightKg === undefined || !l.sizeBought) continue;
    if (Math.abs(l.heightCm - h) > 3 || Math.abs(l.weightKg - w) > 3) continue;
    let g = groups.get(l.sizeBought);
    if (!g) {
      g = { sizeBought: l.sizeBought, count: 0, sizing: { runs_small: 0, runs_large: 0, true_to_size: 0 } };
      groups.set(l.sizeBought, g);
    }
    g.count++;
    if (l.sizing) g.sizing[l.sizing]++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
