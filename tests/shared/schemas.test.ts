import { describe, it, expect } from 'vitest';
import { ProfileSchema, SettingsSchema, DEFAULT_PROFILE, DEFAULT_MODEL } from '../../src/shared/schemas';

describe('ProfileSchema', () => {
  it('accepts an empty profile', () => expect(ProfileSchema.parse(DEFAULT_PROFILE)).toEqual(DEFAULT_PROFILE));
  it('rejects negative and absurd cm', () => {
    expect(() => ProfileSchema.parse({ ...DEFAULT_PROFILE, body: { chest: -5 } })).toThrow();
    expect(() => ProfileSchema.parse({ ...DEFAULT_PROFILE, body: { chest: 400 } })).toThrow();
  });
  it('requires a tag on each garment measure', () => {
    const p = { ...DEFAULT_PROFILE, garments: { top: { label: 'hoodie', measures: { chest: { value: 120 } } } } };
    expect(() => ProfileSchema.parse(p)).toThrow();
  });
  it('rejects a width tag on a length measure', () => {
    const p = { ...DEFAULT_PROFILE, garments: { top: { label: 'h', measures: { sleeve: { value: 62, tag: 'relaxed' } } } } };
    expect(() => ProfileSchema.parse(p)).toThrow();
  });
  it('accepts correctly tagged width and length measures', () => {
    const p = { ...DEFAULT_PROFILE, garments: { top: { label: 'h', measures: {
      chest: { value: 120, tag: 'relaxed' }, sleeve: { value: 62, tag: 'just_right' } } } } };
    expect(ProfileSchema.parse(p)).toEqual(p);
  });
  it('enforces height and weight bounds', () => {
    expect(() => ProfileSchema.parse({ ...DEFAULT_PROFILE, body: { heightCm: 90 } })).toThrow();
    expect(() => ProfileSchema.parse({ ...DEFAULT_PROFILE, body: { weightKg: 300 } })).toThrow();
  });
});

describe('SettingsSchema', () => {
  it('defaults model', () => expect(SettingsSchema.parse({ apiKey: 'sk-ant-x' }).model).toBe('claude-sonnet-5-5'));
  it('accepts an optional fallbackCnyToCad in range', () => {
    expect(SettingsSchema.parse({ apiKey: 'k' }).fallbackCnyToCad).toBeUndefined();
    expect(SettingsSchema.parse({ apiKey: 'k', fallbackCnyToCad: 0.19 }).fallbackCnyToCad).toBe(0.19);
  });
  it('rejects fallbackCnyToCad out of range', () => {
    expect(() => SettingsSchema.parse({ apiKey: 'k', fallbackCnyToCad: 2 })).toThrow();
    expect(() => SettingsSchema.parse({ apiKey: 'k', fallbackCnyToCad: 0.01 })).toThrow();
  });
  it('exports the default model constant', () => expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5'));
});
