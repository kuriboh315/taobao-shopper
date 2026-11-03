// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fillFromDom, findReviewScroller, openReviewsView, productFromDom } from '../../src/collect/dom';
import type { ProductData } from '../../src/shared/types';

const HTML = `
  <div class="ItemHeader--root"><h1 class="ItemHeader--mainTitle--abc">纯棉短袖T恤男</h1></div>
  <div class="ItemHeader--salesDesc">已售 1万+</div>
  <div class="ShopHeader--score">
    <span>宝贝描述</span><span>4.8</span>
    <span>卖家服务</span><span>4.7 高</span>
    <span>物流服务</span><span>4.9</span>
  </div>
  <div id="description" class="desc-root">
    <img data-src="//img.alicdn.com/imgextra/i1/d1.jpg_400x400q90.jpg" src="//g.alicdn.com/s.gif">
    <img data-ks-lazyload="//img.alicdn.com/imgextra/i2/d2.jpg">
    <img src="https://img.alicdn.com/imgextra/i3/d3.png">
    <img src="data:image/gif;base64,R0lGOD">
    <img data-src="//img.alicdn.com/imgextra/i1/d1.jpg">
  </div>`;

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<html><head><title>纯棉短袖T恤男-淘宝网</title></head><body>${html}</body></html>`, 'text/html');
}

describe('productFromDom', () => {
  it('reads title, sales, DSR and detail images', () => {
    expect(productFromDom(doc(HTML))).toEqual({
      title: '纯棉短袖T恤男',
      salesText: '已售 1万+',
      salesCount: 10000,
      shop: { dsr: { description: 4.8, service: 4.7, shipping: 4.9 }, extra: [] },
      images: { main: [], sku: [], detail: [
        'https://img.alicdn.com/imgextra/i1/d1.jpg',
        'https://img.alicdn.com/imgextra/i2/d2.jpg',
        'https://img.alicdn.com/imgextra/i3/d3.png',
      ] },
    });
  });

  it('falls back to the document title without the site suffix', () => {
    expect(productFromDom(doc('<p>nothing</p>')).title).toBe('纯棉短袖T恤男');
  });

  it('returns no fields for an empty page', () => {
    const d = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(productFromDom(d)).toEqual({});
  });
});

describe('fillFromDom', () => {
  const base: ProductData = {
    itemId: '1', title: '', skuSizes: [], shop: { extra: [] }, images: { main: ['https://a/m.jpg'], sku: [], detail: [] },
  };

  it('fills only what parseProduct left empty', () => {
    const filled = fillFromDom({ ...base, salesText: '已售 300+', shop: { name: 'S', dsr: { description: 4.9 }, extra: [] } },
      productFromDom(doc(HTML)));
    expect(filled.title).toBe('纯棉短袖T恤男');
    expect(filled.salesText).toBe('已售 300+');
    expect(filled.shop).toEqual({ name: 'S', dsr: { description: 4.9 }, extra: [] });
    expect(filled.images.main).toEqual(['https://a/m.jpg']);
    expect(filled.images.detail).toHaveLength(3);
  });

  it('keeps existing detail images', () => {
    const p = { ...base, images: { ...base.images, detail: ['https://img.alicdn.com/x.jpg'] } };
    expect(fillFromDom(p, productFromDom(doc(HTML))).images.detail).toEqual(['https://img.alicdn.com/x.jpg']);
  });
});

// ---- review view (uses the live jsdom document: getComputedStyle needs a window) ----

/** jsdom has no layout: give scrollable-looking elements a height. */
function showing(el: Element | null): HTMLElement {
  Object.defineProperty(el!, 'clientHeight', { configurable: true, get: () => 500 });
  return el as HTMLElement;
}

const PREVIEW_IN_SCROLLING_LAYOUT = `
  <div class="layout--main" style="overflow-y: auto">
    <div class="Comments--eCO">
      <div class="comments--Chx" style="overflow-y: hidden"><div class="Comment--H5Q">好</div></div>
      <div class="footer--g"><div class="ShowButton--f">View all reviews</div></div>
    </div>
  </div>`;

const waiter = { sleep: async () => {}, stopped: () => false };

describe('findReviewScroller', () => {
  it('never picks a scrollable layout wrapper around the inline preview', () => {
    document.body.innerHTML = PREVIEW_IN_SCROLLING_LAYOUT;
    showing(document.querySelector('.layout--main'));
    showing(document.querySelector('.comments--Chx'));
    expect(findReviewScroller(document)).toBeNull();
  });

  it("picks the drawer's review list when the drawer is open", () => {
    document.body.innerHTML = `${PREVIEW_IN_SCROLLING_LAYOUT}
      <div class="Drawer--nzZ"><div class="content--nux" style="overflow-y: auto">
        <div class="Comments--eCO"><div class="comments--Chx list" style="overflow-y: scroll">
          <div class="Comment--H5Q">a</div><div class="Comment--H5Q">b</div>
        </div></div>
      </div></div>`;
    showing(document.querySelector('.layout--main'));
    showing(document.querySelector('.content--nux'));
    const list = showing(document.querySelector('.comments--Chx.list'));
    expect(findReviewScroller(document)).toBe(list);
  });
});

describe('openReviewsView', () => {
  it('clicks the control when only the inline preview is in a scrollable layout', async () => {
    document.body.innerHTML = PREVIEW_IN_SCROLLING_LAYOUT;
    showing(document.querySelector('.layout--main'));
    const click = vi.fn();
    document.querySelector('.ShowButton--f')!.addEventListener('click', click);
    await openReviewsView(document, waiter);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('never clicks a link that could navigate', async () => {
    document.body.innerHTML = '<a href="https://rate.taobao.com/list?id=1">View all reviews</a>';
    const click = vi.fn((e: Event) => e.preventDefault());
    document.addEventListener('click', click);
    try {
      expect(await openReviewsView(document, waiter)).toBe(false);
      expect(click).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('click', click);
    }
  });

  it('skips a navigating link for the next candidate; script-only links are fine', async () => {
    document.body.innerHTML = `
      <a href="//rate.tmall.com/list"><span>查看全部评价</span></a>
      <a href="javascript:;" class="tab">User Reviews</a>`;
    const click = vi.fn((e: Event) => e.preventDefault());
    document.addEventListener('click', click);
    try {
      await openReviewsView(document, waiter);
      expect(click).toHaveBeenCalledTimes(1);
      expect((click.mock.calls[0]![0] as Event).target).toBe(document.querySelector('.tab'));
    } finally {
      document.removeEventListener('click', click);
    }
  });
});
