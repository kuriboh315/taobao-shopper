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
  it('body only', () =>
    expect(detailFor({ chest: 122 }, { chest: 120 }, { body: { chest: 108 } })).toEqual(['chest +14 cm vs your body']));
  it('negative body delta uses the minus sign', () =>
    expect(detailFor({ chest: 100 }, { chest: 120 }, { body: { chest: 108 } })).toEqual(['chest −8 cm vs your body']));
});
