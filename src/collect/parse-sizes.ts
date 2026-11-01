import { z } from 'zod';
import type { Category, ChartRow, HwRow, MeasureKey, SizeChart } from '../shared/types';

// ---- constants ---------------------------------------------------------------

/** Title keywords per category, checked in order (pants before shoes so 靴裤 stays a bottom). */
const CATEGORY_KEYWORDS: [Category, RegExp][] = [
  ['bottom', /裤/],
  ['shoe', /鞋|靴/],
  ['outerwear', /外套|夹克|羽绒|大衣|风衣/],
  ['top', /T恤|短袖|卫衣|衬衫|毛衣|上衣/i],
];

/** Chinese measurement names to keys; anything else is dropped. */
const MEASURE_NAMES: Record<string, MeasureKey> = {
  胸围: 'chest',
  衣长: 'length', 裤长: 'length', 裤侧长: 'length', 后中长: 'length',
  肩宽: 'shoulder',
  袖长: 'sleeve',
  腰围: 'waist', 适合腰围: 'waist',
  臀围: 'hips',
  大腿围: 'thigh', 腿围: 'thigh',
  脚口: 'legOpening', 裤脚: 'legOpening',
  内长: 'inseam', 内裆: 'inseam', 内裆长: 'inseam',
  脚长: 'footLength',
};

/** Path below `componentsVO` to the size-table component's tables. */
const SIZE_TABLE_PATH = ['sizeTableVO', 'sizeTableTaoDetailView', 'datas', 'sizeData'] as const;
const SIZE_TABLE_KEY = 'sizeTable';
const HEIGHT_TABLE_KEY = 'heightTable';

const RANGE = String.raw`(\d+(?:\.\d+)?)\s*[-~～至到]\s*(\d+(?:\.\d+)?)`;
const WEIGHT_JIN = new RegExp(`${RANGE}\\s*斤`);
const WEIGHT_KG = new RegExp(`${RANGE}\\s*(?:kg|公斤)`, 'i');
const HEIGHT_CM = new RegExp(`${RANGE}\\s*(?:cm|厘米)`, 'i');
/** Guidance pieces removed from a size label: bracketed notes and unit ranges. */
const LABEL_NOISE = new RegExp(`【[^】]*】|\\[[^\\]]*\\]|\\([^)]*\\)|（[^）]*）|${RANGE}\\s*(?:斤|kg|公斤|cm|厘米)`, 'gi');
/** GB/T 1335 size such as 175/88A: the number is the height, and each step covers ±2 cm. */
const GB_SIZE = /^(1[4-9]\d)\/\d{2,3}[A-Z]?$/i;
const GB_HALF_STEP = 2;
const CELL_EMPTY = /^[-—–]?$/;
const MIN_CM = 5;
const MAX_CM = 300;

// ---- schemas -----------------------------------------------------------------

const Cell = z.object({ value: z.union([z.string(), z.number()]).optional().catch(undefined) }).passthrough();
const Column = z.object({ data: z.array(Cell) }).passthrough();
const Table = z.object({
  data: z.array(z.object({ data: z.object({ columnsData: z.array(Column) }).passthrough() }).passthrough()).min(1),
}).passthrough();

export interface SizeValue { name: string; sizeDescList: { key?: string; value?: string | number }[] }

// ---- helpers -----------------------------------------------------------------

export function inferCategory(title: string): Category {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(title)) return cat;
  return 'other';
}

function measureKey(name: string): MeasureKey | undefined {
  const clean = name.replace(/\([^)]*\)|（[^）]*）|cm|厘米|\s/gi, '');
  return MEASURE_NAMES[clean];
}

/** "68.0cm" → 68, "480mm" → 48; anything else (ranges, text) → undefined. */
function parseCm(v: unknown): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(cm|厘米|mm|毫米)?$/i.exec(String(v ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]) / (m[2] && /mm|毫米/i.test(m[2]) ? 10 : 1);
  return n >= MIN_CM && n <= MAX_CM ? n : undefined;
}

function range(text: string, re: RegExp): [number, number] | undefined {
  const m = re.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Splits a SKU label such as "XL 120-140斤（约60-70kg）" into the size ("XL") and its body guidance. */
export function splitSizeLabel(raw: string): { label: string; hw?: HwRow } {
  const label = raw.replace(LABEL_NOISE, ' ').replace(/\s+/g, ' ').trim() || raw.trim();
  const hw: HwRow = { label };
  const kg = range(raw, WEIGHT_KG);
  const jin = range(raw, WEIGHT_JIN);
  if (kg) [hw.weightMinKg, hw.weightMaxKg] = kg;
  else if (jin) [hw.weightMinKg, hw.weightMaxKg] = [jin[0] / 2, jin[1] / 2];
  const cm = range(raw, HEIGHT_CM);
  const gb = GB_SIZE.exec(label);
  if (cm) [hw.heightMin, hw.heightMax] = cm;
  else if (gb) [hw.heightMin, hw.heightMax] = [Number(gb[1]) - GB_HALF_STEP, Number(gb[1]) + GB_HALF_STEP];
  return Object.keys(hw).length > 1 ? { label, hw } : { label };
}

function measuresOf(pairs: [string, unknown][]): Partial<Record<MeasureKey, number>> {
  const out: Partial<Record<MeasureKey, number>> = {};
  for (const [name, value] of pairs) {
    const key = measureKey(name);
    const cm = parseCm(value);
    if (key && cm !== undefined && out[key] === undefined) out[key] = cm;
  }
  return out;
}

/** Column-major cell grid of a size-table component table, or null. */
function grid(table: unknown): string[][] | null {
  const t = Table.safeParse(table);
  if (!t.success) return null;
  return t.data.data[0]!.data.columnsData.map((c) => c.data.map((cell) => String(cell.value ?? '').trim()));
}

/** The size table comes either with one column per measurement or one column per size; pick the one whose headers are measurements. */
function rowsFromSizeTable(table: unknown): ChartRow[] {
  const g = grid(table);
  if (!g || g.length < 2) return [];
  const col0 = g[0]!;
  const headerCount = (names: string[]) => names.filter((n) => measureKey(n)).length;
  const perMeasure = headerCount(g.slice(1).map((c) => c[0] ?? ''));
  const perSize = headerCount(col0.slice(1));
  const rows: ChartRow[] = [];
  if (perMeasure >= perSize && perMeasure > 0) {
    for (let r = 1; r < col0.length; r++) {
      const label = col0[r]!;
      if (CELL_EMPTY.test(label)) continue;
      rows.push({ label, measures: measuresOf(g.slice(1).map((c) => [c[0] ?? '', c[r]])) });
    }
  } else if (perSize > 0) {
    for (const c of g.slice(1)) {
      const label = c[0] ?? '';
      if (CELL_EMPTY.test(label)) continue;
      rows.push({ label, measures: measuresOf(col0.slice(1).map((name, r) => [name, c[r + 1]])) });
    }
  }
  return rows.filter((r) => Object.keys(r.measures).length > 0);
}

function bounds(text: string): [number, number] | undefined {
  const m = new RegExp(RANGE).exec(text);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = /^(\d+(?:\.\d+)?)$/.exec(text.trim());
  return n ? [Number(n[1]), Number(n[1])] : undefined;
}

/** Height × weight grid: column 0 holds heights, other columns start with a weight range, cells are sizes. */
function hwFromHeightTable(table: unknown): HwRow[] {
  const g = grid(table);
  if (!g || g.length < 2) return [];
  const corner = g[0]![0] ?? '';
  const weightsFirst = /^体重/.test(corner);
  const jin = /斤/.test(corner);
  const out: HwRow[] = [];
  for (const col of g.slice(1)) {
    for (let r = 1; r < col.length; r++) {
      const label = col[r]!;
      if (CELL_EMPTY.test(label)) continue;
      const h = bounds(weightsFirst ? col[0]! : g[0]![r] ?? '');
      const w = bounds(weightsFirst ? g[0]![r] ?? '' : col[0]!);
      if (!h || !w) continue;
      const k = jin ? 0.5 : 1;
      out.push({ label, heightMin: h[0], heightMax: h[1], weightMinKg: w[0] * k, weightMaxKg: w[1] * k });
    }
  }
  return out;
}

function sizeTables(componentsVO: unknown): { sizeTable?: unknown; heightTable?: unknown } {
  let cur: unknown = componentsVO;
  for (const key of SIZE_TABLE_PATH) {
    if (typeof cur !== 'object' || cur === null) return {};
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== 'object' || cur === null) return {};
  const d = cur as Record<string, unknown>;
  return { sizeTable: d[SIZE_TABLE_KEY], heightTable: d[HEIGHT_TABLE_KEY] };
}

// ---- entry point -------------------------------------------------------------

/**
 * Builds the page's own size chart. Rows come from the size values' `sizeDescList`, else the size-table
 * component. The height/weight table comes from guidance in the size labels, else the height table component.
 * Returns undefined when the page has neither.
 */
export function structuredSizeChart(title: string, sizeValues: SizeValue[], componentsVO: unknown): SizeChart | undefined {
  const tables = sizeTables(componentsVO);
  const labels = sizeValues.map((v) => splitSizeLabel(v.name));

  let rows: ChartRow[] = sizeValues
    .map((v, i) => ({ label: labels[i]!.label, measures: measuresOf(v.sizeDescList.map((d) => [d.key ?? '', d.value])) }))
    .filter((r) => Object.keys(r.measures).length > 0);
  if (rows.length === 0) rows = rowsFromSizeTable(tables.sizeTable);

  let hwTable = labels.flatMap((l) => (l.hw ? [l.hw] : []));
  if (hwTable.length === 0) hwTable = hwFromHeightTable(tables.heightTable);

  if (rows.length === 0 && hwTable.length === 0) return undefined;
  return { found: rows.length > 0, category: inferCategory(title), rows, hwTable };
}
