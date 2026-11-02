// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderReport, renderState, type PanelState } from '../../src/panel/render';
import { buildReport, type Report } from '../../src/report/build';
import { DEFAULT_PROFILE as P } from '../../src/shared/schemas';

const report = (): Report => ({
  summary: { sizeTile: 'XL', reviewsLean: 'XXL?', positivePct: 82, sold: '10k+' },
  price: {
    cny: '¥129–159', cad: 'CA$25.09–30.93', coupon: 'After discount ¥119 ≈ CA$23.14', discounted: '¥119 ≈ CA$23.14',
    rateNote: '1 CNY = 0.1945 CAD (ECB, 2026-10-30)',
  },
  size: {
    chartFound: true, shopGuide: null,
    chartSays: 'Chart says XL — Relaxed', reviewsSay: '4 of 10 sizing comments say it runs small',
    quotes: [{ zh: '偏小一码，建议拍大一号', en: 'Runs one size small, order one up' }],
    fitChoice: { category: 'top', usual: 'slightly_relaxed', current: 'slightly_relaxed' },
    fit: {
      basis: 'garment', recommended: 'XL', comparedAgainst: 'vs your body (chest 108) and fav hoodie',
      sizes: [
        { label: 'L', measures: { chest: 116, length: 70 }, deltas: {}, note: 'Regular', detail: ['L detail line'] },
        { label: 'XL', measures: { chest: 122, length: 72 }, deltas: {}, note: 'Relaxed', detail: ['XL detail line'] },
        { label: 'XXL', measures: { chest: 128, length: 74 }, deltas: {}, note: 'Very baggy', detail: ['XXL detail line'] },
      ],
    },
  },
  reviews: {
    positivePct: 82, total: 40, liked: ['thick and warm'], disliked: ['pilling'],
    quotes: [{ zh: '面料很厚实', en: 'Fabric is thick' }],
  },
  shop: { rows: [['Sold', '10k+'], ['Shop age', '5 months']] },
  flags: [
    { group: 'quality', text: 'Pilling after washing', source: '14 reviews' },
    { group: 'shop', text: 'Shop opened 5 months ago', source: 'shop page' },
  ],
});

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="r"></div>';
  root = document.getElementById('r')!;
});

describe('renderReport', () => {
  it('has 4 tab links and the Flags count', () => {
    renderReport(root, report());
    const tabs = [...root.querySelectorAll('nav.tabs a')].map(a => a.textContent);
    expect(tabs).toEqual(['Size', 'Reviews', 'Shop', 'Flags (2)']);
    expect(root.querySelector('nav.tabs a.flags-hot')).not.toBeNull();
  });

  it('marks the recommended row with a star', () => {
    renderReport(root, report());
    const row = [...root.querySelectorAll('table tr')].find(tr => tr.textContent!.includes('★'));
    expect(row).toBeDefined();
    expect(row!.textContent).toContain('XL');
    expect(row!.classList.contains('rec')).toBe(true);
  });

  it('shows the discounted price prominently, with the list price and rate note', () => {
    renderReport(root, report());
    const price = root.querySelector('.price')!;
    expect(price.querySelector('.main')!.textContent).toBe('¥119 ≈ CA$23.14 (was ¥129–159)');
    expect(price.textContent).toContain('1 CNY = 0.1945 CAD');
    expect(price.nextElementSibling!.classList.contains('summary')).toBe(true);
  });

  it('shows the list price with CAD when there is no discount', () => {
    const r = report();
    r.price = { ...r.price!, coupon: null, discounted: null };
    renderReport(root, r);
    expect(root.querySelector('.price .main')!.textContent).toBe('¥129–159 ≈ CA$25.09–30.93');
  });

  it('shows only CNY and a note without an exchange rate', () => {
    const r = report();
    r.price = { cny: '¥129', cad: null, coupon: null, discounted: null, rateNote: null };
    renderReport(root, r);
    expect(root.querySelector('.price')!.textContent).toContain('¥129');
    expect(root.querySelector('.price')!.textContent).toContain('CAD rate unavailable');
  });

  it('shows no price line when price is null', () => {
    const r = report();
    r.price = null;
    renderReport(root, r);
    expect(root.querySelector('.price')).toBeNull();
  });

  it('renders recommended and neighbouring detail lines', () => {
    renderReport(root, report());
    const text = root.querySelector('#s-size')!.textContent!;
    expect(text).toContain('XL detail line');
    expect(text).toContain('Size down');
    expect(text).toContain('L detail line');
    expect(text).toContain('Size up');
    expect(text).toContain('XXL detail line');
    expect(text).toContain('vs your body (chest 108)');
  });

  it('renders the fit selector with current pressed, your fit label, and no reset link', () => {
    renderReport(root, report());
    const btns = [...root.querySelectorAll<HTMLButtonElement>('.fit-select button')];
    expect(btns.map(b => b.dataset.pref)).toEqual(['fitted', 'true_to_size', 'slightly_relaxed', 'oversized']);
    expect(btns.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.pref)).toEqual(['slightly_relaxed']);
    expect(btns[2]!.textContent).toContain('your fit');
    expect(root.querySelector('.fit-reset')).toBeNull();
  });

  it('shows a reset link only when current differs from usual, and wires the handlers', () => {
    const r = report();
    r.size!.fitChoice!.current = 'oversized';
    const onFit = vi.fn();
    renderReport(root, r, { handlers: { onFit, onReanalyse: vi.fn() } });
    root.querySelector<HTMLElement>('.fit-reset')!.click();
    expect(onFit).toHaveBeenLastCalledWith(null);
    root.querySelector<HTMLButtonElement>('.fit-select button[data-pref="fitted"]')!.click();
    expect(onFit).toHaveBeenLastCalledWith('fitted');
    root.querySelector<HTMLButtonElement>('.fit-select button[data-pref="slightly_relaxed"]')!.click();
    expect(onFit).toHaveBeenLastCalledWith(null);
  });

  it('hides the fit selector when fitChoice is null', () => {
    const r = report();
    r.size!.fitChoice = null;
    renderReport(root, r);
    expect(root.querySelector('.fit-select')).toBeNull();
  });

  it('shows group labels and sources on flags', () => {
    renderReport(root, report());
    const flags = root.querySelector('#s-flags')!.textContent!;
    expect(flags).toContain('Quality');
    expect(flags).toContain('14 reviews');
    expect(flags).toContain('Shop trust');
    expect(flags).toContain('shop page');
  });

  it('footer shows Re-analyse and time ago', () => {
    const onReanalyse = vi.fn();
    renderReport(root, report(), { at: 1_000_000, now: 1_000_000 + 3 * 3600_000, handlers: { onFit: vi.fn(), onReanalyse } });
    expect(root.querySelector('footer')!.textContent).toContain('Analysed 3 hours ago');
    root.querySelector<HTMLButtonElement>('footer button')!.click();
    expect(onReanalyse).toHaveBeenCalledOnce();
  });

  it('renders the no-chart notice and the labelled shop guide from a real buildReport', () => {
    const profile = { ...P, body: { heightCm: 175, weightKg: 70 } };
    const run = {
      at: 1,
      product: { itemId: '1', title: 't', skuSizes: ['M', 'L'], shop: { extra: [] }, images: { main: [], sku: [], detail: [] } },
      reviews: [],
      chart: {
        found: false, category: 'top' as const, rows: [],
        hwTable: [
          { label: 'M', heightMin: 160, heightMax: 170, weightMinKg: 50, weightMaxKg: 60 },
          { label: 'L', heightMin: 170, heightMax: 180, weightMinKg: 65, weightMaxKg: 75 },
        ],
      },
      analysis: null,
    };
    renderReport(root, buildReport(run, profile, null));
    const t = root.querySelector('#s-size')!.textContent!;
    expect(t).toContain('No size chart found in the photos');
    expect(t).toContain("Shop's guide says L");
    expect(t).not.toContain('★');
  });

  it('renders the no-chart notice and the shop guide', () => {
    const r = report();
    r.size!.chartFound = false;
    r.size!.fit = null;
    r.size!.chartSays = null;
    r.size!.fitChoice = null;
    r.size!.shopGuide = "Shop's guide says L";
    renderReport(root, r);
    const t = root.querySelector('#s-size')!.textContent!;
    expect(t).toContain('No size chart found in the photos');
    expect(t).toContain("Shop's guide says L");
    expect(t).not.toContain('★');
  });

  it('puts quote Chinese above English', () => {
    renderReport(root, report());
    const q = root.querySelector('#s-size .quote')!;
    expect(q.children[0]!.textContent).toBe('偏小一码，建议拍大一号');
    expect(q.children[1]!.textContent).toBe('Runs one size small, order one up');
  });

  it('shows the empty reviews message when there are no reviews', () => {
    const r = report();
    r.reviews = { positivePct: null, total: 0, liked: [], disliked: [], quotes: [] };
    renderReport(root, r);
    expect(root.querySelector('#s-rev')!.textContent).toContain('No reviews found on this page.');
  });

  it('renders scraped text literally and creates no elements from it', () => {
    const r = report();
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    r.reviews.quotes = [{ zh: evil, en: evil }];
    r.reviews.liked = [evil];
    r.flags = [{ group: 'fit', text: evil, source: evil }];
    r.shop.rows = [[evil, evil]];
    renderReport(root, r);
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('#s-rev')!.textContent).toContain(evil);
  });

  it('omits the Size tab and section when size is null', () => {
    const r = report();
    r.size = null;
    renderReport(root, r);
    expect([...root.querySelectorAll('nav.tabs a')].map(a => a.textContent)).toEqual(['Reviews', 'Shop', 'Flags (2)']);
    expect(root.querySelector('#s-size')).toBeNull();
  });
});

describe('renderReport settings button', () => {
  it('is in the sticky header and calls onSettings once', () => {
    const onSettings = vi.fn();
    renderReport(root, report(), { handlers: { onSettings } });
    const b = root.querySelector<HTMLButtonElement>('header button[aria-label="Edit sizing settings"]')!;
    expect(b.textContent).toBe('⚙ Settings');
    b.click();
    expect(onSettings).toHaveBeenCalledOnce();
  });
  it('shows English sold count in the summary tile', () => {
    const r = report();
    r.summary.sold = '4000+ sold';
    renderReport(root, r);
    expect(root.querySelector('.summary')!.textContent).toContain('4000+ sold');
    expect(root.querySelector('.summary')!.textContent).not.toContain('sold sold');
  });
});

describe('renderState', () => {
  const show = (s: PanelState, handlers = {}) => { renderState(root, s, handlers); return root.textContent!; };

  const settingsBtn = () => root.querySelector<HTMLButtonElement>('header button[aria-label="Edit sizing settings"]');
  it.each<PanelState>([
    { kind: 'not_taobao' }, { kind: 'no_settings' }, { kind: 'idle' }, { kind: 'progress', msg: 'x' },
    { kind: 'captcha' }, { kind: 'error', msg: 'x' },
  ])('shows the Settings button in the header: $kind', (s) => {
    const onSettings = vi.fn();
    show(s, { onSettings });
    expect(settingsBtn()!.textContent).toBe('⚙ Settings');
    settingsBtn()!.click();
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it('not_taobao', () => {
    expect(show({ kind: 'not_taobao' })).toContain('Open a Taobao or Tmall product page to analyse it.');
  });
  it('no_settings with a button to open options', () => {
    const onSettings = vi.fn();
    expect(show({ kind: 'no_settings' }, { onSettings })).toContain('Add your Anthropic API key in Settings first.');
    root.querySelector<HTMLButtonElement>('.state button')!.click();
    expect(onSettings).toHaveBeenCalledOnce();
  });
  it('idle', () => {
    const onAnalyse = vi.fn();
    show({ kind: 'idle' }, { onAnalyse });
    const b = root.querySelector<HTMLButtonElement>('.state button')!;
    expect(b.textContent).toBe('Analyse this product');
    b.click();
    expect(onAnalyse).toHaveBeenCalledOnce();
  });
  it('progress', () => {
    expect(show({ kind: 'progress', msg: 'Reading reviews (12 so far)…' })).toContain('Reading reviews (12 so far)…');
  });
  it('captcha with Continue and Use what you have', () => {
    const onResume = vi.fn();
    const onFinish = vi.fn();
    expect(show({ kind: 'captcha' }, { onResume, onFinish }))
      .toContain('Taobao is asking for a verification. Solve it in the page, then click Continue.');
    const [a, b] = [...root.querySelectorAll<HTMLButtonElement>('.state button')];
    expect(a!.textContent).toBe('Continue');
    expect(b!.textContent).toBe('Use what you have');
    a!.click();
    b!.click();
    expect(onResume).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledOnce();
  });
  it('error with Retry', () => {
    const onRetry = vi.fn();
    expect(show({ kind: 'error', msg: 'Boom.' }, { onRetry })).toContain('Boom.');
    const b = root.querySelector<HTMLButtonElement>('.state button')!;
    expect(b.textContent).toBe('Retry');
    b.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
