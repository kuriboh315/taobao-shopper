import { STD_EASE, easeLevel } from './ease';
import type { Body, LengthKey, MeasureKey, RefGarment, RefMeasure, WidthKey, WidthTag } from '../shared/types';

/** Display order for per-measure output. */
export const KEY_ORDER: MeasureKey[] = ['chest', 'waist', 'hips', 'thigh', 'shoulder', 'legOpening', 'length', 'sleeve', 'inseam', 'footLength'];

const LENGTH_NAMES: Record<LengthKey, string> = { length: 'length', sleeve: 'sleeves', inseam: 'inseam' };
const LEVEL_PHRASE: Record<WidthTag, string> = {
  tight: 'Tight', fitted: 'Fitted', just_right: 'Regular', relaxed: 'Relaxed', oversized: 'Oversized',
};
const BAGGY_MARGIN = 6;
const LENGTH_NOTE_THRESHOLD = 2;
const SAME_THRESHOLD = 1;

export const isLengthKey = (k: string): k is LengthKey => k === 'length' || k === 'sleeve' || k === 'inseam';
export const isWidthKey = (k: string): k is WidthKey => k in STD_EASE;

const MINUS = '−';
const num = (n: number): string => String(Math.round(n * 10) / 10);
const signed = (n: number): string => (n < 0 ? `${MINUS}${num(-n)}` : `+${num(n)}`);
const words = (tag: string): string => tag.replace(/_/g, ' ');

export interface NoteCtx { body?: number; garment?: RefMeasure }

/**
 * Short fragment for one measure of one size; '' when there is nothing worth saying.
 * Width keys give the fit level, length keys give "name ±delta" once |delta| > 2.
 */
export function noteFor(key: MeasureKey, sizeValue: number, target: number | undefined, ctx: NoteCtx): string {
  if (isLengthKey(key)) {
    if (target === undefined) return '';
    const d = sizeValue - target;
    return Math.abs(d) > LENGTH_NOTE_THRESHOLD ? `${LENGTH_NAMES[key]} ${signed(d)}` : '';
  }
  if (!isWidthKey(key)) return '';
  let ease: number;
  if (ctx.body !== undefined) ease = sizeValue - ctx.body;
  else if (ctx.garment && target !== undefined && ctx.garment.tag in STD_EASE[key]) {
    ease = STD_EASE[key][ctx.garment.tag as WidthTag] + (sizeValue - ctx.garment.value);
  } else return '';
  if (ease > STD_EASE[key].oversized + BAGGY_MARGIN) return 'Very baggy';
  return LEVEL_PHRASE[easeLevel(key, ease)];
}

export interface DetailCtx { body: Body; garment?: RefGarment }

/** Per-measure comparison lines for the recommended size (spec section 6, point 4). */
export function detailFor(measures: Partial<Record<MeasureKey, number>>, t: Partial<Record<MeasureKey, number>>, ctx: DetailCtx): string[] {
  const out: string[] = [];
  for (const key of KEY_ORDER) {
    const v = measures[key];
    if (v === undefined || t[key] === undefined) continue;
    const g = ctx.garment?.measures[key as Exclude<MeasureKey, 'footLength'>];
    const name = isLengthKey(key) ? LENGTH_NAMES[key] : key;
    if (g && ctx.garment) {
      const d = v - g.value;
      const ref = `your ${ctx.garment.label}`;
      if (isLengthKey(key)) {
        const tail = g.tag === 'just_right' ? '' : ` (which you find ${words(g.tag)})`;
        out.push(Math.abs(d) <= SAME_THRESHOLD
          ? `${name} same as ${ref}${tail}`
          : `${name} ${num(Math.abs(d))} cm ${d > 0 ? 'longer' : 'shorter'} than ${ref}${tail}`);
      } else {
        const tag = g.tag as WidthTag;
        const level = easeLevel(key as WidthKey, STD_EASE[key as WidthKey][tag] + d);
        const tail = level === tag ? ` (${words(tag)})` : ` (${words(tag)} → ${words(level)})`;
        out.push(Math.abs(d) <= SAME_THRESHOLD
          ? `${name} same as ${ref}${tail}`
          : `${name} ${num(Math.abs(d))} cm ${d > 0 ? 'roomier' : 'tighter'} than ${ref}${tail}`);
      }
    } else {
      const b = ctx.body[key as keyof Body];
      if (typeof b === 'number') out.push(`${name} ${signed(v - b)} cm vs your body`);
    }
  }
  return out;
}
