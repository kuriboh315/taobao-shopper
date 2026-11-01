// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/profile/storage', () => ({
  loadProfile: vi.fn(async () => ({
    body: {}, garments: {},
    prefs: { top: 'true_to_size', outerwear: 'true_to_size', bottom: 'true_to_size', shoe: 'true_to_size' },
  })),
  saveProfile: vi.fn(async () => {}),
  loadSettings: vi.fn(async () => null),
  saveSettings: vi.fn(async () => {}),
}));

import * as storage from '../../src/profile/storage';
import { mountOptions, readForm, fillForm } from '../../src/options/options';
import type { Profile } from '../../src/shared/types';

let root: HTMLElement;
const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${name}"]`)!;
const set = (name: string, v: string) => { field(name).value = v; };
const save = () => root.querySelector<HTMLButtonElement>('button[type="submit"], #save')!.click();
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="test-root"></div>';
  root = document.getElementById('test-root')!;
  await mountOptions(root);
});

describe('options page', () => {
  it('shows an inline message and does not save when a value has no tag', async () => {
    set('garment.top.chest.value', '120');
    save();
    await flush();
    const row = root.querySelector('[data-row="garment.top.chest"]')!;
    expect(row.textContent).toContain('Choose how this fits you');
    expect(storage.saveProfile).not.toHaveBeenCalled();
  });

  it('shows the fixed measuring hints and optional outerwear hint', () => {
    expect(root.textContent).toContain('Measure around the fullest part of your chest, tape level.');
    expect(root.textContent).toContain('Heel to longest toe, standing.');
    expect(root.textContent).toContain('uses Top if empty');
    expect(root.textContent).toContain("Used only if today's rate can't be fetched.");
  });

  it('builds the expected Profile from a filled form and saves it', async () => {
    set('body.heightCm', '175');
    set('body.chest', '96');
    set('garment.top.label', 'Uniqlo M');
    set('garment.top.note', 'boxy');
    set('garment.top.chest.value', '110');
    set('garment.top.chest.tag', 'just_right');
    set('garment.top.length.value', '70');
    set('garment.top.length.tag', 'slightly_long');
    set('garment.bottom.waist.value', '84');
    set('garment.bottom.waist.tag', 'fitted');
    set('shoe.label', 'Nike 42');
    set('shoe.sizeEU', '42');
    set('shoe.insoleCm', '27');
    set('pref.top', 'slightly_relaxed');
    const expected: Profile = {
      body: { heightCm: 175, chest: 96 },
      garments: {
        top: { label: 'Uniqlo M', note: 'boxy', measures: {
          chest: { value: 110, tag: 'just_right' }, length: { value: 70, tag: 'slightly_long' } } },
        bottom: { label: '', measures: { waist: { value: 84, tag: 'fitted' } } },
      },
      shoe: { label: 'Nike 42', sizeEU: 42, insoleCm: 27 },
      prefs: { top: 'slightly_relaxed', outerwear: 'true_to_size', bottom: 'true_to_size', shoe: 'true_to_size' },
    };
    expect(readForm(root)).toEqual(expected);
    save();
    await flush();
    expect(storage.saveProfile).toHaveBeenCalledWith(expected);
    expect(storage.saveSettings).toHaveBeenCalledWith({ apiKey: '', model: 'claude-sonnet-5-5' });
  });

  it('round-trips through fillForm and readForm', () => {
    const p: Profile = {
      body: { weightKg: 70, footLength: 26 },
      garments: { outerwear: { label: 'Coat', measures: { sleeve: { value: 62, tag: 'too_short' } } } },
      prefs: { top: 'fitted', outerwear: 'oversized', bottom: 'true_to_size', shoe: 'fitted' },
    };
    fillForm(root, p);
    expect(readForm(root)).toEqual(p);
  });

  it('saves the backup rate and key as settings', async () => {
    set('settings.apiKey', 'sk-test');
    set('settings.fallbackCnyToCad', '0.19');
    save();
    await flush();
    expect(storage.saveSettings).toHaveBeenCalledWith({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', fallbackCnyToCad: 0.19 });
  });

  it('rejects an out-of-range backup rate without saving anything', async () => {
    set('settings.fallbackCnyToCad', '5');
    save();
    await flush();
    expect(root.querySelector('[data-row="settings.fallbackCnyToCad"] .error')!.textContent).not.toBe('');
    expect(storage.saveSettings).not.toHaveBeenCalled();
    expect(storage.saveProfile).not.toHaveBeenCalled();
  });

  it('shows a schema error next to the offending field and saves neither', async () => {
    set('body.chest', '9999');
    save();
    await flush();
    expect(root.querySelector('[data-row="body.chest"] .error')!.textContent).not.toBe('');
    expect(storage.saveProfile).not.toHaveBeenCalled();
    expect(storage.saveSettings).not.toHaveBeenCalled();
  });

  it('reads the full set of garment measures', () => {
    set('garment.top.shoulder.value', '46');
    set('garment.top.shoulder.tag', 'relaxed');
    set('garment.bottom.hips.value', '100');
    set('garment.bottom.hips.tag', 'just_right');
    set('garment.bottom.thigh.value', '60');
    set('garment.bottom.thigh.tag', 'fitted');
    set('garment.bottom.legOpening.value', '40');
    set('garment.bottom.legOpening.tag', 'relaxed');
    set('garment.bottom.length.value', '100');
    set('garment.bottom.length.tag', 'slightly_long');
    const g = readForm(root).garments;
    expect(g.top?.measures.shoulder).toEqual({ value: 46, tag: 'relaxed' });
    expect(g.bottom?.measures).toEqual({
      hips: { value: 100, tag: 'just_right' }, thigh: { value: 60, tag: 'fitted' },
      legOpening: { value: 40, tag: 'relaxed' }, length: { value: 100, tag: 'slightly_long' },
    });
  });
});
