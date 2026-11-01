export type Rect = { x: number; y: number; w: number; h: number };

export type Tile = {
  src: string;
  /** Position of the source URL in the input list. */
  index: number;
  /** Strip number within that image, 0-based, top to bottom. */
  tile: number;
  media_type: 'image/jpeg';
  /** Base64 JPEG, no data: prefix. */
  data: string;
};

export type LoadedImage = { width: number; height: number; source: unknown };

/** Browser-dependent steps, injectable so fetchTiles can be tested in Node. */
export type ImageDeps = {
  load: (url: string) => Promise<LoadedImage>;
  encode: (img: LoadedImage, rect: Rect, maxEdge: number) => Promise<string>;
};

const HEIGHT_RATIO = 1.4;
const JPEG_QUALITY = 0.85;

/**
 * Splits an image into full-width horizontal strips. Strip height is
 * min(h, round(w * 1.4)); consecutive strips overlap by `overlap` px so a chart
 * cut at one boundary appears whole in a neighbour. The last strip ends at h.
 */
export function tileRects(w: number, h: number, maxEdge = 1568, overlap = 120): Rect[] {
  void maxEdge; // scaling to maxEdge happens at encode time; geometry is in source pixels
  if (!(w > 0) || !(h > 0)) return [];
  const stripH = Math.min(h, Math.round(w * HEIGHT_RATIO));
  const step = Math.max(1, stripH - overlap);
  const rects: Rect[] = [];
  let y = 0;
  for (;;) {
    if (y + stripH >= h) {
      rects.push({ x: 0, y, w, h: h - y });
      break;
    }
    rects.push({ x: 0, y, w, h: stripH });
    y += step;
  }
  return rects;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const FETCH_TIMEOUT_MS = 10_000;

/** Fetches an image body, aborting if the request or body read exceeds timeoutMs. */
export async function fetchImageBlob(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Blob> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

const browserDeps: ImageDeps = {
  async load(url) {
    const bmp = await createImageBitmap(await fetchImageBlob(url));
    return { width: bmp.width, height: bmp.height, source: bmp };
  },
  async encode(img, rect, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(rect.w, rect.h));
    const outW = Math.max(1, Math.round(rect.w * scale));
    const outH = Math.max(1, Math.round(rect.h * scale));
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img.source as ImageBitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, outW, outH);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return toBase64(new Uint8Array(await blob.arrayBuffer()));
  },
};

/**
 * Fetches each URL and returns base64 JPEG tiles in input order, stopping at
 * maxTiles. A URL that fails to load or encode is skipped and logged.
 */
export async function fetchTiles(
  urls: string[],
  opts: { maxEdge: number; maxTiles: number },
  deps: ImageDeps = browserDeps,
): Promise<Tile[]> {
  const tiles: Tile[] = [];
  for (let index = 0; index < urls.length && tiles.length < opts.maxTiles; index++) {
    const src = urls[index]!;
    try {
      const img = await deps.load(src);
      const rects = tileRects(img.width, img.height, opts.maxEdge);
      const out: Tile[] = [];
      for (let tile = 0; tile < rects.length && tiles.length + out.length < opts.maxTiles; tile++) {
        const data = await deps.encode(img, rects[tile]!, opts.maxEdge);
        out.push({ src, index, tile, media_type: 'image/jpeg', data });
      }
      tiles.push(...out);
      (img.source as { close?: () => void } | null)?.close?.();
    } catch (err) {
      console.warn(`[images] skipping ${src}:`, err);
    }
  }
  return tiles;
}
