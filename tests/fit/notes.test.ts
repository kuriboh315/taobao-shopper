import { describe, it, expect } from 'vitest';
import { noteFor, detailFor } from '../../src/fit/notes';

describe('noteFor', () => {
  it('width key with body → ease level phrase', () => {
    expect(noteFor('chest', 116, 120, { body: 108 })).toBe('Regular');
    expect(noteFor('chest', 122, 120, { body: 108 })).toBe('Relaxed');
    expect(noteFor('chest', 100, 120, { body: 108 })).toBe('Tight');
    expect(noteFor('chest', 112, 120, { body: 108 })).toBe('Fitted');
    expect(noteFor('chest', 132, 120, { body: 108 })).toBe('Oversized');
    expect(noteFor('chest', 140, 120, { body: 108 })).toBe('Very baggy');
  });
  it('width key without body compares to the garment', () => {
    expect(noteFor('chest', 122, 120, { garment: { value: 120, tag: 'relaxed' } })).toBe('Relaxed');
    expect(noteFor('chest', 128, 120, { garment: { value: 120, tag: 'relaxed' } })).toBe('Oversized');
  });
  describe('calibrated on the reference garment (jeans waist 80, just right; body waist 80)', () => {
    const ctx = { body: 80, garment: { value: 80, tag: 'just_right' as const } };
    it.each([
      [80, 'Regular'], [82, 'Relaxed'], [84, 'Oversized'], [76, 'Tight'], [96, 'Very baggy'],
    ])('chart waist %i → %s', (w, word) => expect(noteFor('waist', w, 80, ctx)).toBe(word));
  });
  it('width key with nothing to compare → empty', () => expect(noteFor('chest', 122, 120, {})).toBe(''));
  it('length keys only past 2 cm, named and signed', () => {
    expect(noteFor('sleeve', 58, 60, {})).toBe('');
    expect(noteFor('sleeve', 57, 60, {})).toBe('sleeves −3');
    expect(noteFor('length', 74, 71, {})).toBe('length +3');
    expect(noteFor('inseam', 80, 76, {})).toBe('inseam +4');
  });
  it('missing target → empty', () => expect(noteFor('length', 70, undefined, {})).toBe(''));
});

describe('detailFor', () => {
  const jeans = { label: 'favourite jeans', measures: { waist: { value: 80, tag: 'just_right' as const } } };
  it('arrow target agrees with the note level word', () => {
    const ctx = { body: { waist: 80 }, garment: jeans };
    const note = noteFor('waist', 84, 80, { body: 80, garment: jeans.measures.waist });
    const [line] = detailFor({ waist: 84 }, { waist: 80 }, ctx);
    expect(line).toBe('waist 4 cm roomier than your favourite jeans (just right → oversized)');
    expect(note.toLowerCase()).toBe(line!.match(/→ (.+)\)$/)![1]);
  });
  it('arrow says very baggy where the note does', () => {
    const [line] = detailFor({ waist: 96 }, { waist: 80 }, { body: { waist: 80 }, garment: jeans });
    expect(line).toContain('(just right → very baggy)');
  });
  it('body only', () =>
    expect(detailFor({ chest: 122 }, { chest: 120 }, { body: { chest: 108 } })).toEqual(['chest +14 cm vs your body']));
  it('negative body delta uses the minus sign', () =>
    expect(detailFor({ chest: 100 }, { chest: 120 }, { body: { chest: 108 } })).toEqual(['chest −8 cm vs your body']));
});
