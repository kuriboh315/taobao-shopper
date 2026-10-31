import { describe, it, expect } from 'vitest';
import { normalizeSizeLabel } from '../../src/shared/sizeLabel';

describe('normalizeSizeLabel', () => {
  it('strips bracketed text', () => {
    expect(normalizeSizeLabel('XL【建议130-150斤】')).toBe('XL');
    expect(normalizeSizeLabel('L(推荐)')).toBe('L');
    expect(normalizeSizeLabel('M（偏大）')).toBe('M');
  });
  it('maps numeric XL forms', () => {
    expect(normalizeSizeLabel('2XL')).toBe('XXL');
    expect(normalizeSizeLabel('3xl')).toBe('XXXL');
    expect(normalizeSizeLabel('4XL')).toBe('XXXXL');
  });
  it('strips 码 and whitespace, uppercases', () => {
    expect(normalizeSizeLabel('S码')).toBe('S');
    expect(normalizeSizeLabel(' x l ')).toBe('XL');
  });
  it('keeps XXL and 均码 as is', () => {
    expect(normalizeSizeLabel('XXL')).toBe('XXL');
    expect(normalizeSizeLabel('均码')).toBe('均码');
  });
  it('leaves numeric sizes alone', () => {
    expect(normalizeSizeLabel('42码')).toBe('42');
  });
});
