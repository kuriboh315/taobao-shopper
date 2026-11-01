import type { Flag, Report } from '../report/build';
import type { FitPref } from '../shared/types';
import { button, el, timeAgo } from './dom';
import { quoteEl, sizeSection, type ReportHandlers } from './render-size';

export type { ReportHandlers } from './render-size';

export type PanelState =
  | { kind: 'not_taobao' }
  | { kind: 'no_settings' }
  | { kind: 'idle'; cachedAt?: number }
  | { kind: 'progress'; msg: string }
  | { kind: 'captcha' }
  | { kind: 'error'; msg: string };

export interface StateHandlers {
  onSettings?: () => void;
  onAnalyse?: () => void;
  onResume?: () => void;
  onFinish?: () => void;
  onRetry?: () => void;
}

export interface ReportOptions { at?: number; now?: number; handlers?: Partial<ReportHandlers> }

const GROUP_LABEL: Record<Flag['group'], string> = { fit: 'Fit', quality: 'Quality', shop: 'Shop trust' };
const CATEGORY_LABEL = { top: 'tops', outerwear: 'outerwear', bottom: 'bottoms', shoe: 'shoes' } as const;
const PREF_LABEL: Record<FitPref, string> = {
  fitted: 'fitted', true_to_size: 'true to size', slightly_relaxed: 'relaxed', oversized: 'oversized',
};

function jump(id: string): (e: Event) => void {
  return (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
}

function header(hint: string | null, tabs: [string, string, string?][] = []): HTMLElement {
  const nav = tabs.length
    ? el('nav', { class: 'tabs' }, ...tabs.map(([label, id, cls]) =>
      el('a', { class: cls, attrs: { href: `#${id}` }, on: { click: jump(id) } }, label)))
    : null;
  return el('header', { class: 'top' },
    el('div', { class: 'hdr' }, el('span', {}, 'Taobao Shopper'), hint ? el('span', { class: 'muted' }, hint) : null),
    nav);
}

function priceBlock(price: NonNullable<Report['price']>): HTMLElement {
  return el('div', { class: 'price' },
    el('div', { class: 'main' }, price.discounted
      ? `${price.discounted} (was ${price.cny})`
      : price.cad ? `${price.cny} ≈ ${price.cad}` : price.cny),
    el('div', { class: 'muted' }, price.rateNote ?? 'CAD rate unavailable'));
}

function summaryRow(r: Report): HTMLElement {
  const tile = (value: string, label: string, cls?: string) =>
    el('div', { class: cls }, el('b', {}, value), label);
  return el('div', { class: 'summary' },
    r.size ? tile(r.summary.sizeTile, 'chart pick', 'size') : null,
    r.summary.reviewsLean ? tile(r.summary.reviewsLean, 'reviews lean') : null,
    r.summary.positivePct !== null ? tile(`${r.summary.positivePct}%`, 'positive') : null,
    r.summary.sold ? tile(r.summary.sold, 'sold') : null);
}

function reviewsSection(rv: Report['reviews']): HTMLElement {
  const sec = el('section', { id: 's-rev' }, el('h4', {}, 'Reviews'));
  if (rv.total === 0) {
    sec.append(el('div', { class: 'muted' }, 'No reviews found on this page.'));
    return sec;
  }
  if (rv.positivePct !== null) {
    const fill = el('span');
    fill.style.width = `${Math.min(100, Math.max(0, rv.positivePct))}%`;
    sec.append(
      el('div', { class: 'muted' }, `Positive ${rv.positivePct}%`),
      el('div', { class: 'bar' }, fill));
  }
  if (rv.liked.length) sec.append(el('div', {}, el('b', {}, 'Liked: '), rv.liked.join(', ')));
  if (rv.disliked.length) sec.append(el('div', {}, el('b', {}, 'Disliked: '), rv.disliked.join(', ')));
  for (const q of rv.quotes) sec.append(quoteEl(q));
  return sec;
}

function shopSection(rows: [string, string][]): HTMLElement {
  const grid = el('div', { class: 'kv' });
  for (const [k, v] of rows) grid.append(el('span', {}, k), el('b', {}, v));
  return el('section', { id: 's-shop' }, el('h4', {}, 'Shop'),
    rows.length ? grid : el('div', { class: 'muted' }, 'No shop details found.'));
}

function flagsSection(flags: Flag[]): HTMLElement {
  return el('section', { id: 's-flags' }, el('h4', {}, 'Red flags'),
    ...(flags.length
      ? flags.map(f => el('div', { class: 'flag' }, el('b', {}, `${GROUP_LABEL[f.group]}: `), `${f.text} (${f.source})`))
      : [el('div', { class: 'muted' }, 'No red flags found.')]));
}

export function renderReport(root: HTMLElement, r: Report, opts: ReportOptions = {}): void {
  const handlers: ReportHandlers = { onFit: () => {}, onReanalyse: () => {}, ...opts.handlers };
  const choice = r.size?.fitChoice;
  const hint = choice ? `Profile: ${CATEGORY_LABEL[choice.category]} = ${PREF_LABEL[choice.usual]}` : null;
  const tabs: [string, string, string?][] = [
    ...(r.size ? [['Size', 's-size'] as [string, string]] : []),
    ['Reviews', 's-rev'],
    ['Shop', 's-shop'],
    [`Flags (${r.flags.length})`, 's-flags', r.flags.length > 0 ? 'flags-hot' : undefined],
  ];
  const footer = el('footer', {},
    opts.at !== undefined ? el('span', { class: 'muted' }, `Analysed ${timeAgo(opts.at, opts.now ?? Date.now())}`) : null,
    button('Re-analyse', handlers.onReanalyse));
  root.replaceChildren(
    header(hint, tabs),
    el('div', { class: 'body' },
      r.price ? priceBlock(r.price) : null,
      summaryRow(r),
      r.size ? sizeSection(r.size, handlers) : null,
      reviewsSection(r.reviews),
      shopSection(r.shop.rows),
      flagsSection(r.flags),
      footer));
}

export function renderState(root: HTMLElement, s: PanelState, h: StateHandlers = {}): void {
  const card = (text: string, ...actions: HTMLElement[]) =>
    el('div', { class: `state ${s.kind}` }, el('p', {}, text), el('div', { class: 'actions' }, ...actions));
  let body: HTMLElement;
  switch (s.kind) {
    case 'not_taobao':
      body = card('Open a Taobao or Tmall product page to analyse it.');
      break;
    case 'no_settings':
      body = card('Add your Anthropic API key in Settings first.', button('Open Settings', h.onSettings));
      break;
    case 'idle':
      body = card('Ready when you are.', button('Analyse this product', h.onAnalyse, 'primary'));
      break;
    case 'progress':
      body = card(s.msg);
      body.setAttribute('aria-live', 'polite');
      break;
    case 'captcha':
      body = card('Taobao is asking for a verification. Solve it in the page, then click Continue.',
        button('Continue', h.onResume, 'primary'), button('Use what you have', h.onFinish));
      break;
    case 'error':
      body = card(s.msg, button('Retry', h.onRetry, 'primary'));
      break;
  }
  root.replaceChildren(header(null), el('div', { class: 'body' }, body));
}
