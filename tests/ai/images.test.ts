import { describe, it, expect, vi } from 'vitest';
import { tileRects, fetchTiles } from '../../src/ai/images';
import type { ImageDeps } from '../../src/ai/images';

describe('tileRects', () => {
  it('gives one rect for an image shorter than the strip height', () => {
    expect(tileRects(790, 900)).toEqual([{ x: 0, y: 0, w: 790, h: 900 }]);
  });

  it('covers a tall image with overlapping strips', () => {
    const rects = tileRects(790, 5000);
    expect(rects.length).toBeGreaterThan(1);
    expect(rects[0]!.y).toBe(0);
    for (const r of rects) {
      expect(r.h).toBeLessThanOrEqual(1106);
      expect(r.w).toBe(790);
      expect(r.x).toBe(0);
    }
    for (let i = 1; i < rects.length; i++) {
      const prev = rects[i - 1]!;
      expect(prev.y + prev.h - rects[i]!.y).toBe(120);
    }
  });

  it('ends exactly at the image bottom', () => {
    const rects = tileRects(790, 5000);
    const last = rects[rects.length - 1]!;
    expect(last.y + last.h).toBe(5000);
  });

  it('treats a wide image as a single strip', () => {
    expect(tileRects(2000, 800)).toEqual([{ x: 0, y: 0, w: 2000, h: 800 }]);
  });

  it('returns nothing for empty dimensions', () => {
    expect(tileRects(0, 100)).toEqual([]);
    expect(tileRects(100, 0)).toEqual([]);
  });
});

describe('fetchTiles', () => {
  const makeDeps = (failUrl?: string): ImageDeps => ({
    load: vi.fn(async (url: string) => {
      if (url === failUrl) throw new Error('boom');
      return { width: 790, height: 2000, source: url };
    }),
    encode: vi.fn(async (_img, rect) => `b64-${rect.y}`),
  });

  it('skips a failed URL and keeps indices of the input list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tiles = await fetchTiles(['a', 'bad', 'c'], { maxEdge: 1568, maxTiles: 100 }, makeDeps('bad'));
    expect(tiles.map((t) => t.src)).not.toContain('bad');
    expect(new Set(tiles.map((t) => t.index))).toEqual(new Set([0, 2]));
    expect(tiles[0]).toMatchObject({ src: 'a', index: 0, tile: 0, media_type: 'image/jpeg', data: 'b64-0' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops at maxTiles', async () => {
    const tiles = await fetchTiles(['a', 'b'], { maxEdge: 1568, maxTiles: 2 }, makeDeps());
    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => t.tile)).toEqual([0, 1]);
  });
});
