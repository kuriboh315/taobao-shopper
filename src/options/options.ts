import { ZodError } from 'zod';
import { DEFAULT_MODEL, SettingsSchema } from '../shared/schemas';
import { loadProfile, loadSettings, saveProfile, saveSettings } from '../profile/storage';
import type { Body, FitPref, LengthTag, MeasureKey, Profile, RefGarment, RefMeasure, Settings, ShoeRef, WidthTag } from '../shared/types';

type GarmentCat = 'top' | 'outerwear' | 'bottom';
type GarmentKey = Exclude<MeasureKey, 'footLength'>;

interface NumField { key: keyof Body; label: string; unit?: string; hint?: string }
interface MeasureDef { key: GarmentKey; label: string; kind: 'width' | 'length'; hint: string }

const BODY_FIELDS: NumField[] = [
  { key: 'heightCm', label: 'Height', unit: 'cm' },
  { key: 'weightKg', label: 'Weight', unit: 'kg' },
  { key: 'chest', label: 'Chest', unit: 'cm', hint: 'Measure around the fullest part of your chest, tape level.' },
  { key: 'waist', label: 'Waist', unit: 'cm' },
  { key: 'hips', label: 'Hips', unit: 'cm' },
  { key: 'shoulder', label: 'Shoulder width', unit: 'cm' },
  { key: 'sleeve', label: 'Sleeve length', unit: 'cm' },
  { key: 'inseam', label: 'Inseam', unit: 'cm' },
  { key: 'thigh', label: 'Thigh', unit: 'cm' },
  { key: 'footLength', label: 'Foot length', unit: 'cm', hint: 'Heel to longest toe, standing.' },
  { key: 'shoeSizeEU', label: 'Shoe size (EU)' },
  { key: 'shoeSizeCN', label: 'Shoe size (CN)' },
];

const CHEST: MeasureDef = { key: 'chest', label: 'Chest', kind: 'width',
  hint: 'Lay flat, measure armpit to armpit, then double it. Taobao charts list garment measurements, not body measurements.' };
const LENGTH: MeasureDef = { key: 'length', label: 'Length', kind: 'length', hint: 'From the highest point of the shoulder to the hem.' };
const SLEEVE: MeasureDef = { key: 'sleeve', label: 'Sleeve', kind: 'length', hint: 'From the shoulder seam to the cuff.' };
const WAIST: MeasureDef = { key: 'waist', label: 'Waist', kind: 'width', hint: 'Lay flat, measure across the waistband, then double it.' };
const INSEAM: MeasureDef = { key: 'inseam', label: 'Inseam', kind: 'length', hint: 'From the crotch seam to the hem.' };

const GARMENTS: { cat: GarmentCat; title: string; hint?: string; measures: MeasureDef[] }[] = [
  { cat: 'top', title: 'Top you know fits', measures: [CHEST, LENGTH, SLEEVE] },
  { cat: 'outerwear', title: 'Outerwear you know fits (optional)', hint: 'Leave blank if you have none; uses Top if empty.', measures: [CHEST, LENGTH, SLEEVE] },
  { cat: 'bottom', title: 'Bottom you know fits', measures: [WAIST, INSEAM] },
];

const SHOE_FIELDS: { key: 'sizeEU' | 'sizeCN' | 'insoleCm'; label: string; unit?: string }[] = [
  { key: 'sizeEU', label: 'EU size' },
  { key: 'sizeCN', label: 'CN size' },
  { key: 'insoleCm', label: 'Insole length', unit: 'cm' },
];

const WIDTH_TAGS: [WidthTag, string][] = [
  ['tight', 'Tight'], ['fitted', 'Fitted'], ['just_right', 'Just right'], ['relaxed', 'Relaxed'], ['oversized', 'Oversized'],
];
const LENGTH_TAGS: [LengthTag, string][] = [
  ['too_short', 'Too short'], ['slightly_short', 'Slightly short'], ['just_right', 'Just right'],
  ['slightly_long', 'Slightly long'], ['too_long', 'Too long'],
];
const PREFS: [FitPref, string][] = [
  ['fitted', 'Fitted'], ['true_to_size', 'True to size'], ['slightly_relaxed', 'Slightly relaxed'], ['oversized', 'Oversized'],
];
const PREF_CATS: [keyof Profile['prefs'], string][] = [
  ['top', 'Tops'], ['outerwear', 'Outerwear'], ['bottom', 'Bottoms'], ['shoe', 'Shoes'],
];

const NEED_TAG = 'Choose how this fits you';

// ---------- DOM building ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

function input(name: string, type: 'text' | 'number' | 'password'): HTMLInputElement {
  const i = el('input', { type });
  i.dataset.field = name;
  if (type === 'number') i.step = 'any';
  return i;
}

function select(name: string, options: [string, string][], blank?: string): HTMLSelectElement {
  const s = el('select');
  s.dataset.field = name;
  if (blank !== undefined) s.append(el('option', { value: '', textContent: blank }));
  for (const [value, text] of options) s.append(el('option', { value, textContent: text }));
  return s;
}

/** A labelled row with an optional hint and an error slot, keyed by `data-row`. */
function row(rowKey: string, label: string, controls: Node[], unit?: string, hint?: string): HTMLElement {
  const r = el('div', { className: 'row' });
  r.dataset.row = rowKey;
  r.append(el('label', { textContent: label }), el('span', { className: 'controls' }, ...controls));
  if (unit) r.append(el('span', { className: 'unit', textContent: unit }));
  if (hint) r.append(el('p', { className: 'hint', textContent: hint }));
  r.append(el('p', { className: 'error', role: 'alert' }));
  return r;
}

function section(title: string, ...kids: Node[]): HTMLElement {
  return el('fieldset', {}, el('legend', { textContent: title }), ...kids);
}

export function buildForm(root: HTMLElement): void {
  const form = el('form', { id: 'options-form', noValidate: true });

  form.append(section('Body', ...BODY_FIELDS.map((f) => row(`body.${f.key}`, f.label, [input(`body.${f.key}`, 'number')], f.unit, f.hint))));

  for (const g of GARMENTS) {
    const kids: Node[] = [];
    if (g.hint) kids.push(el('p', { className: 'hint', textContent: g.hint }));
    kids.push(row(`garment.${g.cat}.label`, 'Label', [input(`garment.${g.cat}.label`, 'text')]));
    kids.push(row(`garment.${g.cat}.note`, 'Note', [input(`garment.${g.cat}.note`, 'text')]));
    for (const m of g.measures) {
      const name = `garment.${g.cat}.${m.key}`;
      const tags = m.kind === 'width' ? WIDTH_TAGS : LENGTH_TAGS;
      kids.push(row(name, m.label, [input(`${name}.value`, 'number'), select(`${name}.tag`, tags, 'How it fits')], 'cm', m.hint));
    }
    form.append(section(g.title, ...kids));
  }

  form.append(section('Shoes',
    row('shoe.label', 'Label', [input('shoe.label', 'text')]),
    ...SHOE_FIELDS.map((f) => row(`shoe.${f.key}`, f.label, [input(`shoe.${f.key}`, 'number')], f.unit))));

  form.append(section('Fit preference',
    ...PREF_CATS.map(([cat, label]) => row(`pref.${cat}`, label, [select(`pref.${cat}`, PREFS)]))));

  form.append(section('API',
    row('settings.apiKey', 'API key', [input('settings.apiKey', 'password')]),
    row('settings.model', 'Model', [input('settings.model', 'text')])));

  form.append(section('Currency',
    row('settings.fallbackCnyToCad', 'Backup exchange rate (1 CNY in CAD)', [input('settings.fallbackCnyToCad', 'number')],
      undefined, "Used only if today's rate can't be fetched.")));

  form.append(el('button', { type: 'submit', id: 'save', textContent: 'Save' }), el('span', { id: 'status', role: 'status' }));
  root.replaceChildren(form);
  (form.querySelector('[data-field="settings.model"]') as HTMLInputElement).value = DEFAULT_MODEL;
}

// ---------- form <-> data ----------

const ctl = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${name}"]`);
const val = (root: HTMLElement, name: string) => ctl(root, name)?.value.trim() ?? '';
const num = (root: HTMLElement, name: string): number | undefined => {
  const v = val(root, name);
  return v === '' ? undefined : Number(v);
};
const setVal = (root: HTMLElement, name: string, v: string | number | undefined) => {
  const c = ctl(root, name);
  if (c) c.value = v === undefined ? '' : String(v);
};

function readGarment(root: HTMLElement, cat: GarmentCat, defs: MeasureDef[]): RefGarment | undefined {
  const measures: RefGarment['measures'] = {};
  for (const m of defs) {
    const value = num(root, `garment.${cat}.${m.key}.value`);
    const tag = val(root, `garment.${cat}.${m.key}.tag`);
    if (value !== undefined && tag) measures[m.key] = { value, tag } as RefMeasure; // untagged values are rejected before saving
  }
  const label = val(root, `garment.${cat}.label`);
  const note = val(root, `garment.${cat}.note`);
  if (!label && !note && Object.keys(measures).length === 0) return undefined;
  return { label, ...(note ? { note } : {}), measures };
}

export function readForm(root: HTMLElement): Profile {
  const body: Body = {};
  for (const f of BODY_FIELDS) {
    const v = num(root, `body.${f.key}`);
    if (v !== undefined) body[f.key] = v;
  }
  const garments: Profile['garments'] = {};
  for (const g of GARMENTS) {
    const parsed = readGarment(root, g.cat, g.measures);
    if (parsed) garments[g.cat] = parsed;
  }
  const shoe: ShoeRef = { label: val(root, 'shoe.label') };
  let shoeUsed = shoe.label !== '';
  for (const f of SHOE_FIELDS) {
    const v = num(root, `shoe.${f.key}`);
    if (v !== undefined) { shoe[f.key] = v; shoeUsed = true; }
  }
  const prefs = {} as Profile['prefs'];
  for (const [cat] of PREF_CATS) prefs[cat] = (val(root, `pref.${cat}`) || 'true_to_size') as FitPref;
  return { body, garments, ...(shoeUsed ? { shoe } : {}), prefs };
}

export function fillForm(root: HTMLElement, p: Profile): void {
  for (const f of BODY_FIELDS) setVal(root, `body.${f.key}`, p.body[f.key]);
  for (const g of GARMENTS) {
    const ref = p.garments[g.cat];
    setVal(root, `garment.${g.cat}.label`, ref?.label);
    setVal(root, `garment.${g.cat}.note`, ref?.note);
    for (const m of g.measures) {
      setVal(root, `garment.${g.cat}.${m.key}.value`, ref?.measures[m.key]?.value);
      setVal(root, `garment.${g.cat}.${m.key}.tag`, ref?.measures[m.key]?.tag);
    }
  }
  setVal(root, 'shoe.label', p.shoe?.label);
  for (const f of SHOE_FIELDS) setVal(root, `shoe.${f.key}`, p.shoe?.[f.key]);
  for (const [cat] of PREF_CATS) setVal(root, `pref.${cat}`, p.prefs[cat]);
}

export function readSettings(root: HTMLElement): Settings {
  const rate = num(root, 'settings.fallbackCnyToCad');
  return { apiKey: val(root, 'settings.apiKey'), model: val(root, 'settings.model') || DEFAULT_MODEL,
    ...(rate !== undefined ? { fallbackCnyToCad: rate } : {}) };
}

export function fillSettings(root: HTMLElement, s: Settings | null): void {
  setVal(root, 'settings.apiKey', s?.apiKey);
  setVal(root, 'settings.model', s?.model ?? DEFAULT_MODEL);
  setVal(root, 'settings.fallbackCnyToCad', s?.fallbackCnyToCad);
}

// ---------- validation display ----------

function showError(root: HTMLElement, rowKey: string, message: string): boolean {
  const slot = root.querySelector(`[data-row="${rowKey}"] .error`);
  if (!slot) return false;
  slot.textContent = message;
  return true;
}

/** Maps a zod issue path onto the `data-row` key of the form row that owns it. */
function rowKeyForPath(path: PropertyKey[]): string {
  const p = path.map(String);
  if (p[0] === 'garments' && p[2] === 'measures') return `garment.${p[1]}.${p[3]}`;
  if (p[0] === 'garments') return `garment.${p[1]}.${p[2]}`;
  if (p[0] === 'prefs') return `pref.${p[1]}`;
  if (p[0] === 'settings') return `settings.${p[1]}`;
  return p.join('.');
}

function showZodErrors(root: HTMLElement, err: ZodError, prefix: string[] = []): string[] {
  const unplaced: string[] = [];
  for (const issue of err.issues) {
    if (!showError(root, rowKeyForPath([...prefix, ...issue.path]), issue.message)) unplaced.push(issue.message);
  }
  return unplaced;
}

function missingTags(root: HTMLElement): number {
  let count = 0;
  for (const g of GARMENTS) {
    for (const m of g.measures) {
      const name = `garment.${g.cat}.${m.key}`;
      if (val(root, `${name}.value`) !== '' && val(root, `${name}.tag`) === '') {
        showError(root, name, NEED_TAG);
        count++;
      }
    }
  }
  return count;
}

async function save(root: HTMLElement): Promise<void> {
  const status = root.querySelector('#status')!;
  root.querySelectorAll('.error').forEach((e) => { e.textContent = ''; });
  status.textContent = '';
  if (missingTags(root) > 0) { status.textContent = 'Fix the highlighted fields.'; return; }

  const settings = readSettings(root);
  const settingsCheck = SettingsSchema.safeParse(settings);
  let failed = false;
  if (!settingsCheck.success) {
    showZodErrors(root, settingsCheck.error, ['settings']);
    failed = true;
  }
  try {
    await saveProfile(readForm(root));
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    showZodErrors(root, e);
    failed = true;
  }
  if (failed) { status.textContent = 'Fix the highlighted fields.'; return; }
  await saveSettings(settings);
  status.textContent = 'Saved.';
}

export async function mountOptions(root: HTMLElement): Promise<void> {
  buildForm(root);
  const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
  fillForm(root, profile);
  fillSettings(root, settings);
  root.querySelector('form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void save(root);
  });
}

const autoRoot = typeof document !== 'undefined' ? document.getElementById('options-root') : null;
if (autoRoot) void mountOptions(autoRoot);
