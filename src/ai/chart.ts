import { z } from 'zod';
import { callTool, type ContentBlock, type ToolDef } from './client';
import { fetchTiles, type Tile } from './images';
import { normalizeSizeLabel } from '../shared/sizeLabel';
import type { Category, ChartRow, HwRow, MeasureKey, ProductData, Settings, SizeChart } from '../shared/types';

const CATEGORIES = ['top', 'outerwear', 'bottom', 'shoe', 'other'] as const;
const MEASURE_KEYS = [
  'chest', 'waist', 'hips', 'thigh', 'shoulder', 'legOpening', 'length', 'sleeve', 'inseam', 'footLength',
] as const;
const FLAT_DOUBLED = new Set<MeasureKey>(['chest', 'waist', 'hips', 'thigh', 'legOpening']);

const LOCATE_MAX_TILES = 40;
const LOCATE_EDGE = 512;
const READ_MAX_TILES = 6;
const READ_EDGE = 1568;

// ---- tool definitions ------------------------------------------------------

const LOCATE_TOOL: ToolDef = {
  name: 'locate_size_chart',
  description: 'Report which numbered image tiles contain a size table or a height/weight recommendation table.',
  input_schema: {
    type: 'object',
    properties: {
      tiles: { type: 'array', items: { type: 'integer' }, description: 'Tile numbers containing a size table or height/weight table.' },
      category: { type: 'string', enum: [...CATEGORIES], description: 'Garment category of the product.' },
    },
    required: ['tiles', 'category'],
  },
};

const READ_TOOL: ToolDef = {
  name: 'read_size_chart',
  description: 'Transcribe the size table(s) printed in the images.',
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      unit: { type: 'string', enum: ['cm', 'inch', 'mm'] },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Size label exactly as printed, e.g. M, 175/92A, 38.' },
            measures: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name_zh: { type: 'string', description: 'Column header as printed.' },
                  key: { type: ['string', 'null'], enum: [...MEASURE_KEYS, null] },
                  value: { type: 'number' },
                  basis: { type: 'string', enum: ['circumference', 'flat'] },
                },
                required: ['name_zh', 'key', 'value', 'basis'],
              },
            },
          },
          required: ['label', 'measures'],
        },
      },
      hw: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            heightMin: { type: 'number' },
            heightMax: { type: 'number' },
            weightMin: { type: 'number' },
            weightMax: { type: 'number' },
            weightUnit: { type: 'string', enum: ['kg', 'jin'] },
          },
          required: ['label', 'weightUnit'],
        },
      },
    },
    required: ['found', 'unit', 'rows', 'hw'],
  },
};

const LOCATE_SYSTEM =
  'You find size information in product images from a Chinese Taobao listing. Images are numbered tiles. ' +
  'Return the numbers of every tile that contains a size table (尺码表) or a height/weight recommendation table. ' +
  'Also classify the product category. If no tile has such a table, return an empty list.';

const READ_SYSTEM =
  'You transcribe size tables from product images. Transcribe only what is printed; never estimate or infer values. ' +
  'If no table is legible, set found to false and return empty rows. Copy size labels exactly as printed. ' +
  'Set unit to the unit the table uses (cm, inch or mm). Map column headers to keys: ' +
  '胸围→chest, 衣长/后中长/裤长→length, 肩宽→shoulder, 袖长→sleeve, 腰围→waist, 臀围→hips, ' +
  '大腿围/腿围→thigh, 脚口/裤脚→legOpening, 内长/内裆长→inseam, 脚长/内长(鞋)→footLength. ' +
  'Use key null for any other column. Headers such as 胸宽 or ones marked 平铺 are flat (laid flat, half the circumference): ' +
  'set basis to flat for them, otherwise circumference. ' +
  'Put height/weight recommendation tables (身高/体重 per size) in hw, with the weight unit as printed (kg or jin/斤).';

// ---- normalisation ---------------------------------------------------------

const MeasureSchema = z.object({
  name_zh: z.string().optional(),
  key: z.enum(MEASURE_KEYS).nullable().catch(null),
  value: z.number(),
  basis: z.enum(['circumference', 'flat']).catch('circumference'),
});

const RawChartSchema = z.object({
  found: z.boolean(),
  unit: z.enum(['cm', 'inch', 'mm']).catch('cm'),
  rows: z.array(z.object({ label: z.string(), measures: z.array(MeasureSchema) })).catch([]),
  hw: z
    .array(
      z.object({
        label: z.string(),
        heightMin: z.number().optional(),
        heightMax: z.number().optional(),
        weightMin: z.number().optional(),
        weightMax: z.number().optional(),
        weightUnit: z.enum(['kg', 'jin']).catch('kg'),
      }),
    )
    .catch([]),
});

const roundHalf = (v: number) => Math.round(v * 2) / 2;
const inRange = (v: number) => Number.isFinite(v) && v >= 5 && v <= 300;

function emptyChart(category: Category): SizeChart {
  return { found: false, category, rows: [], hwTable: [] };
}

/** Validates model output and converts it to a cm/kg SizeChart. `category` comes from pass 1. */
export function normalizeChart(raw: unknown, skuSizes: string[], category: Category = 'other'): SizeChart {
  const parsed = RawChartSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.found) return emptyChart(category);
  const { unit, rows: rawRows, hw } = parsed.data;
  const toCm = unit === 'inch' ? 2.54 : unit === 'mm' ? 0.1 : 1;

  let rows: ChartRow[] = [];
  for (const r of rawRows) {
    const label = r.label.trim();
    if (!label) continue;
    const measures: Partial<Record<MeasureKey, number>> = {};
    for (const ms of r.measures) {
      if (ms.key === null) continue;
      let v = ms.value * toCm;
      if (ms.basis === 'flat' && FLAT_DOUBLED.has(ms.key)) v *= 2;
      else if (ms.basis === 'circumference' && ((ms.key === 'chest' && v < 70) || (ms.key === 'waist' && v < 50))) v *= 2;
      v = roundHalf(v);
      if (inRange(v)) measures[ms.key] = v;
    }
    if (Object.keys(measures).length > 0) rows.push({ label, measures });
  }

  const hwTable: HwRow[] = [];
  for (const h of hw) {
    const label = h.label.trim();
    if (!label) continue;
    const k = h.weightUnit === 'jin' ? 0.5 : 1;
    const out: HwRow = { label };
    if (h.heightMin !== undefined) out.heightMin = h.heightMin;
    if (h.heightMax !== undefined) out.heightMax = h.heightMax;
    if (h.weightMin !== undefined) out.weightMinKg = h.weightMin * k;
    if (h.weightMax !== undefined) out.weightMaxKg = h.weightMax * k;
    if (Object.keys(out).length > 1) hwTable.push(out);
  }

  const order = new Map<string, number>();
  skuSizes.forEach((s, i) => {
    const n = normalizeSizeLabel(s);
    if (!order.has(n)) order.set(n, i);
  });
  const rank = (r: ChartRow) => order.get(normalizeSizeLabel(r.label)) ?? Infinity;
  rows = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);

  // An hw-only table is still usable by the fit engine, so it keeps `found` true.
  return { found: rows.length > 0 || hwTable.length > 0, category, rows, hwTable };
}

// ---- two-pass reading ------------------------------------------------------

export type ChartDeps = {
  call: typeof callTool;
  fetchTiles: typeof fetchTiles;
};

const imageBlock = (t: Tile): ContentBlock => ({
  type: 'image',
  source: { type: 'base64', media_type: t.media_type, data: t.data },
});

const LocateSchema = z.object({
  tiles: z.array(z.number().int()).catch([]),
  category: z.enum(CATEGORIES).catch('other'),
});

export async function readSizeChart(
  product: ProductData,
  settings: Settings,
  onProgress: (msg: string) => void,
  deps: Partial<ChartDeps> = {},
): Promise<SizeChart> {
  const call = deps.call ?? callTool;
  const getTiles = deps.fetchTiles ?? fetchTiles;

  // Pass 1: locate.
  onProgress('Looking for the size chart in the photos…');
  const urls = [...product.images.detail, ...product.images.sku];
  const small = await getTiles(urls, { maxEdge: LOCATE_EDGE, maxTiles: LOCATE_MAX_TILES });
  if (small.length === 0) return emptyChart('other');

  const intro =
    `Product title: ${product.title}\nSKU sizes: ${product.skuSizes.join(', ') || '(none)'}\n` +
    `Seller size guide text: ${product.sizeGuideText || '(none)'}\n` +
    `The ${small.length} numbered image tiles follow.`;
  const locateContent: ContentBlock[] = [{ type: 'text', text: intro }];
  small.forEach((t, i) => {
    locateContent.push({ type: 'text', text: `Tile ${i}:` }, imageBlock(t));
  });
  const located = LocateSchema.parse(
    await call({ settings, system: LOCATE_SYSTEM, content: locateContent, tool: LOCATE_TOOL, maxTokens: 512 }),
  );
  const category = located.category;

  const picked = [...new Set(located.tiles)].filter((i) => i >= 0 && i < small.length).slice(0, READ_MAX_TILES);
  if (picked.length === 0) return emptyChart(category);

  // Pass 2: re-fetch the same strips at full resolution and read them.
  onProgress('Reading the size chart…');
  const wanted = picked.map((i) => small[i]!);
  const bySrc = new Map<string, number[]>();
  for (const t of wanted) bySrc.set(t.src, [...(bySrc.get(t.src) ?? []), t.tile]);
  const big: Tile[] = [];
  for (const [src, strips] of bySrc) {
    const fetched = await getTiles([src], { maxEdge: READ_EDGE, maxTiles: Math.max(...strips) + 1 });
    for (const strip of strips) {
      const t = fetched.find((f) => f.tile === strip);
      if (t) big.push(t);
    }
  }
  if (big.length === 0) return emptyChart(category);

  const readContent: ContentBlock[] = [
    { type: 'text', text: `Product title: ${product.title}\nSKU sizes: ${product.skuSizes.join(', ') || '(none)'}` },
    ...big.map(imageBlock),
  ];
  const raw = await call({ settings, system: READ_SYSTEM, content: readContent, tool: READ_TOOL, maxTokens: 4096 });
  return normalizeChart(raw, product.skuSizes, category);
}
