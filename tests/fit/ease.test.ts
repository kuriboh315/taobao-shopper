import { describe, it, expect } from 'vitest';
import { targets, easeLevel, garmentFor } from '../../src/fit/ease';
import { DEFAULT_PROFILE as P } from '../../src/shared/schemas';
import type { RefGarment } from '../../src/shared/types';

const hoodie: RefGarment = { label: 'hoodie', measures: { chest: { value: 120, tag: 'relaxed' }, length: { value: 71, tag: 'just_right' }, sleeve: { value: 62, tag: 'slightly_long' } } };

describe('targets', () => {
  it('garment tag equals pref → garment value', () =>
    expect(targets({ ...P, garments: { top: hoodie }, prefs: { ...P.prefs, top: 'slightly_relaxed' } }, 'top').t.chest).toBe(120));
  it('pref looser than tag shifts by table step', () =>
    expect(targets({ ...P, garments: { top: hoodie }, prefs: { ...P.prefs, top: 'oversized' } }, 'top').t.chest).toBe(128));
  it('slightly long sleeve → target shorter', () => expect(targets({ ...P, garments: { top: hoodie } }, 'top').t.sleeve).toBe(60));
  it('length is not changed by pref', () =>
    expect(targets({ ...P, garments: { top: hoodie }, prefs: { ...P.prefs, top: 'oversized' } }, 'top').t.length).toBe(71));
  it('body fallback', () => {
    const r = targets({ ...P, body: { chest: 108 }, prefs: { ...P.prefs, top: 'oversized' } }, 'top');
    expect(r).toEqual({ basis: 'body', t: { chest: 132 } });
  });
  it('body sleeve and inseam are used as-is; length untargeted', () => {
    expect(targets({ ...P, body: { sleeve: 60 } }, 'top').t).toEqual({ sleeve: 60 });
    expect(targets({ ...P, body: { inseam: 78 } }, 'bottom').t).toEqual({ inseam: 78 });
  });
  it('legOpening is never targeted from the body', () =>
    expect(targets({ ...P, body: { waist: 80, thigh: 55 } }, 'bottom').t).not.toHaveProperty('legOpening'));
  it('garment legOpening uses width rule', () => {
    const jeans: RefGarment = { label: 'j', measures: { legOpening: { value: 20, tag: 'relaxed' } } };
    expect(targets({ ...P, garments: { bottom: jeans } }, 'bottom').t.legOpening).toBe(20);
  });
  it('garment plus body fallback reports garment basis', () => {
    const r = targets({ ...P, garments: { top: hoodie }, body: { shoulder: 46 } }, 'top');
    expect(r.basis).toBe('garment');
    expect(r.t.shoulder).toBe(47);
  });
  it('outerwear falls back to top garment', () => expect(targets({ ...P, garments: { top: hoodie } }, 'outerwear').basis).toBe('garment'));
  it('outerwear prefers its own garment', () => {
    const coat: RefGarment = { label: 'c', measures: { chest: { value: 130, tag: 'just_right' } } };
    expect(garmentFor({ ...P, garments: { top: hoodie, outerwear: coat } }, 'outerwear')).toBe(coat);
  });
  it('shoe and other → none', () => {
    expect(targets({ ...P, body: { chest: 100 } }, 'shoe')).toEqual({ basis: 'none', t: {} });
    expect(targets({ ...P, body: { chest: 100 } }, 'other')).toEqual({ basis: 'none', t: {} });
  });
  it('partial profile: nothing → none, no throw', () => expect(targets(P, 'bottom')).toEqual({ basis: 'none', t: {} }));
});

describe('easeLevel', () => {
  it('nearest', () => { expect(easeLevel('chest', 14)).toBe('relaxed'); expect(easeLevel('chest', 30)).toBe('oversized'); });
  it('tie → looser', () => expect(easeLevel('chest', 8)).toBe('just_right'));
});
