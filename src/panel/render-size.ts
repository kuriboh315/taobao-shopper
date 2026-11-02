import type { Quote, Report } from '../report/build';
import type { FitPref, MeasureKey, SizeFit } from '../shared/types';
import { el } from './dom';

export interface ReportHandlers {
  /** A fit button was clicked. `null` means "back to the usual fit". */
  onFit: (pref: FitPref | null) => void;
  onReanalyse: () => void;
  /** The header Settings button was clicked. */
  onSettings?: () => void;
}

type Size = NonNullable<Report['size']>;

const FIT_OPTIONS: [FitPref, string][] = [
  ['fitted', 'Fitted'],
  ['true_to_size', 'True to size'],
  ['slightly_relaxed', 'Relaxed'],
  ['oversized', 'Oversized'],
];

const MEASURE_COLUMNS: [MeasureKey, string][] = [
  ['chest', 'Chest'], ['waist', 'Waist'], ['hips', 'Hips'], ['thigh', 'Thigh'], ['shoulder', 'Shoulder'],
  ['legOpening', 'Leg opening'], ['length', 'Length'], ['sleeve', 'Sleeve'], ['inseam', 'Inseam'], ['footLength', 'Foot'],
];

export function quoteEl(q: Quote): HTMLElement {
  return el('div', { class: 'quote' }, el('span', { class: 'zh' }, q.zh), el('span', { class: 'en' }, q.en));
}

function fitSelector(choice: NonNullable<Size['fitChoice']>, h: ReportHandlers): HTMLElement {
  const buttons = FIT_OPTIONS.map(([pref, label]) =>
    el('button', {
      attrs: { type: 'button', 'data-pref': pref, 'aria-pressed': String(pref === choice.current) },
      on: { click: () => h.onFit(pref === choice.usual ? null : pref) },
    }, label, pref === choice.usual ? el('small', { class: 'yours' }, 'your fit') : null));
  const reset = choice.current !== choice.usual
    ? el('a', { class: 'fit-reset', attrs: { href: '#' }, on: { click: (e) => { e.preventDefault(); h.onFit(null); } } }, 'Reset to my fit')
    : null;
  return el('div', { class: 'fit-wrap' }, el('div', { class: 'fit-select', attrs: { role: 'group', 'aria-label': 'How do you want it to fit?' } }, ...buttons), reset);
}

function sizeTable(sizes: SizeFit[], recommended: string | null): HTMLElement {
  const cols = MEASURE_COLUMNS.filter(([k]) => sizes.some(s => s.measures[k] !== undefined));
  const head = el('tr', {}, el('th', {}, 'Size'), ...cols.map(([, label]) => el('th', {}, label)), el('th', {}, 'Fit for you'));
  const rows = sizes.map((s) => {
    const rec = s.label === recommended;
    return el('tr', { class: rec ? 'rec' : undefined },
      el('td', {}, rec ? `${s.label} ★` : s.label),
      ...cols.map(([k]) => el('td', {}, s.measures[k] !== undefined ? String(s.measures[k]) : '—')),
      el('td', {}, s.note));
  });
  return el('table', { class: 'fit-table' }, head, ...rows);
}

function detailLines(sizes: SizeFit[], recommended: string | null): HTMLElement | null {
  const i = sizes.findIndex(s => s.label === recommended);
  if (i < 0) return null;
  const lines = (s: SizeFit | undefined) => (s?.detail ?? []).map(d => el('div', { class: 'detail' }, d));
  const down = sizes[i - 1];
  const up = sizes[i + 1];
  return el('div', { class: 'details' },
    ...lines(sizes[i]),
    down && down.detail.length ? el('div', { class: 'neighbour' }, el('h5', {}, 'Size down'), ...lines(down)) : null,
    up && up.detail.length ? el('div', { class: 'neighbour' }, el('h5', {}, 'Size up'), ...lines(up)) : null);
}

export function sizeSection(size: Size, h: ReportHandlers): HTMLElement {
  const sec = el('section', { id: 's-size' }, el('h4', {}, 'Size'));
  if (size.fitChoice) sec.append(fitSelector(size.fitChoice, h));
  if (size.chartFound && size.fit) {
    sec.append(sizeTable(size.fit.sizes, size.fit.recommended));
    if (size.fit.comparedAgainst) sec.append(el('div', { class: 'muted' }, size.fit.comparedAgainst));
    const details = detailLines(size.fit.sizes, size.fit.recommended);
    if (details) sec.append(details);
  } else {
    sec.append(el('div', { class: 'notice' }, 'No size chart found in the photos'));
  }
  const boxes = [
    size.chartFound && size.chartSays ? el('div', { class: 'chart' }, el('b', {}, size.chartSays)) : null,
    !size.chartFound && size.shopGuide ? el('div', { class: 'chart' }, el('b', {}, size.shopGuide)) : null,
    size.reviewsSay ? el('div', { class: 'rev' }, el('b', {}, 'Reviews say'), el('br'), size.reviewsSay) : null,
  ].filter(Boolean);
  if (boxes.length) sec.append(el('div', { class: 'two' }, ...boxes));
  for (const q of size.quotes) sec.append(quoteEl(q));
  return sec;
}
