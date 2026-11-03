import type { Category, FitPref, LengthKey, LengthTag, MeasureKey, Profile, RefGarment, WidthKey, WidthTag } from '../shared/types';

/** Body to garment circumference ease in cm, per width key and tag. */
export const STD_EASE: Record<WidthKey, Record<WidthTag, number>> = {
  chest: { tight: 2, fitted: 6, just_right: 10, relaxed: 16, oversized: 24 },
  waist: { tight: -2, fitted: 0, just_right: 2, relaxed: 4, oversized: 8 },
  hips: { tight: 0, fitted: 4, just_right: 8, relaxed: 12, oversized: 18 },
  thigh: { tight: 2, fitted: 4, just_right: 8, relaxed: 12, oversized: 16 },
  shoulder: { tight: -2, fitted: 0, just_right: 1, relaxed: 3, oversized: 6 },
  legOpening: { tight: 0, fitted: 0, just_right: 0, relaxed: 0, oversized: 0 }, // never targeted from body
};

export const LENGTH_CORRECTION: Record<LengthTag, number> = {
  too_short: 4, slightly_short: 2, just_right: 0, slightly_long: -2, too_long: -4,
};

export const PREF_TO_TAG: Record<FitPref, WidthTag> = {
  fitted: 'fitted', true_to_size: 'just_right', slightly_relaxed: 'relaxed', oversized: 'oversized',
};

const WIDTH_KEYS = Object.keys(STD_EASE) as WidthKey[];
const LENGTH_KEYS: LengthKey[] = ['length', 'sleeve', 'inseam'];
const TAG_ORDER: WidthTag[] = ['tight', 'fitted', 'just_right', 'relaxed', 'oversized'];

// Body measures targeted per category (legOpening and length have no body source).
const BODY_KEYS: Partial<Record<Category, (Exclude<WidthKey, 'legOpening'> | 'sleeve' | 'inseam')[]>> = {
  top: ['chest', 'waist', 'hips', 'shoulder', 'sleeve'],
  outerwear: ['chest', 'waist', 'hips', 'shoulder', 'sleeve'],
  bottom: ['waist', 'hips', 'thigh', 'inseam'],
};

const isWidthKey = (k: string): k is WidthKey => (WIDTH_KEYS as string[]).includes(k);

export function garmentFor(profile: Profile, cat: Category): RefGarment | undefined {
  switch (cat) {
    case 'top': return profile.garments.top;
    case 'outerwear': return profile.garments.outerwear ?? profile.garments.top;
    case 'bottom': return profile.garments.bottom;
    default: return undefined;
  }
}

export function targets(profile: Profile, cat: Category):
  { basis: 'garment' | 'body' | 'none'; t: Partial<Record<MeasureKey, number>> } {
  const t: Partial<Record<MeasureKey, number>> = {};
  if (cat === 'shoe' || cat === 'other') return { basis: 'none', t };
  const wantTag = PREF_TO_TAG[profile.prefs[cat]];
  const garment = garmentFor(profile, cat);
  let usedGarment = false;
  let usedBody = false;

  const entries = Object.entries(garment?.measures ?? {}) as [string, { value: number; tag: string }][];
  for (const [k, m] of entries) {
    if (isWidthKey(k)) {
      t[k] = m.value + (STD_EASE[k][wantTag] - STD_EASE[k][m.tag as WidthTag]);
      usedGarment = true;
    } else if ((LENGTH_KEYS as string[]).includes(k)) {
      t[k as LengthKey] = m.value + LENGTH_CORRECTION[m.tag as LengthTag];
      usedGarment = true;
    }
  }

  for (const k of BODY_KEYS[cat] ?? []) {
    if (t[k] !== undefined) continue;
    const b = profile.body[k];
    if (b === undefined) continue;
    t[k] = isWidthKey(k) ? b + STD_EASE[k][wantTag] : b;
    usedBody = true;
  }

  return { basis: usedGarment ? 'garment' : usedBody ? 'body' : 'none', t };
}

/** Nearest tag for a given ease; ties resolve to the looser tag. */
export function easeLevel(key: WidthKey, ease: number): WidthTag {
  let best: WidthTag = 'tight';
  let bestDist = Infinity;
  for (const tag of TAG_ORDER) {
    const d = Math.abs(STD_EASE[key][tag] - ease);
    if (d <= bestDist) { best = tag; bestDist = d; }
  }
  return best;
}
