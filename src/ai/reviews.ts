import { z } from 'zod';
import { callStructured, type JsonSchema } from './client';
import type { ProductData, Review, ReviewAnalysis, ReviewFlag, ReviewLabel, Settings } from '../shared/types';

const MAX_REVIEWS = 80;
const MAX_REVIEW_CHARS = 400;
const MAX_PHRASES = 5;
const MAX_TRANSLATIONS = 8;

// Structured outputs: every object sets additionalProperties:false and lists all its keys in `required`;
// absent values are null. Array length limits are unsupported, so they are enforced in code and the prompt.
const ANALYZE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      description: 'One entry per review.',
      items: {
        type: 'object',
        properties: {
          idx: { type: 'integer', description: 'Review number as shown in brackets.' },
          sentiment: { type: 'string', enum: ['pos', 'neg', 'mixed'] },
          sizing: {
            anyOf: [{ type: 'string', enum: ['runs_small', 'runs_large', 'true_to_size'] }, { type: 'null' }],
            description: 'Set only when the review talks about fit; otherwise null.',
          },
          heightCm: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Reviewer height in cm, only if stated; otherwise null.' },
          weightKg: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Reviewer weight in kg, only if stated (斤 ÷ 2); otherwise null.' },
          sizeBought: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Size the reviewer bought, only if stated; otherwise null.' },
        },
        required: ['idx', 'sentiment', 'sizing', 'heightCm', 'weightKg', 'sizeBought'],
        additionalProperties: false,
      },
    },
    liked: { type: 'array', items: { type: 'string' }, description: `Up to ${MAX_PHRASES} short English phrases.` },
    disliked: { type: 'array', items: { type: 'string' }, description: `Up to ${MAX_PHRASES} short English phrases.` },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string', enum: ['fit', 'quality', 'shop'] },
          text: { type: 'string', description: 'Short English description of the issue.' },
          reviewIdx: { type: 'array', items: { type: 'integer' } },
        },
        required: ['group', 'text', 'reviewIdx'],
        additionalProperties: false,
      },
    },
    translations: {
      type: 'array',
      description: `English translations of up to ${MAX_TRANSLATIONS} of the most representative reviews; at least 3 sizing-related when such reviews exist.`,
      items: {
        type: 'object',
        properties: { idx: { type: 'integer' }, en: { type: 'string' } },
        required: ['idx', 'en'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels', 'liked', 'disliked', 'flags', 'translations'],
  additionalProperties: false,
};

const SYSTEM =
  'You analyse buyer reviews from a Chinese Taobao listing. Reviews are a numbered list: [i] (SKU: …) text. Use the bracketed number as idx. ' +
  'Give every review one label with its sentiment. Set sizing (runs_small, runs_large, true_to_size) only when the review talks about fit, otherwise null. ' +
  'Extract heightCm, weightKg and sizeBought only when the reviewer states them. Weights in 斤 convert to kg by ÷2. Never guess. ' +
  'List up to 5 short English phrases each for what buyers liked and disliked. ' +
  'Red-flag groups are fit / quality / shop only. Listing tricks are out of scope. ' +
  'fit: fit complaints. quality: pilling, thin fabric, smell, fading, loose threads, colour mismatch. ' +
  'shop: shop-trust patterns such as near-identical short reviews or mentions of 好评返现 (cashback for good reviews). ' +
  'Each flag gives short English text and the idx values of the supporting reviews. ' +
  'Translate into English up to 8 reviews you judge most representative (at least 3 about sizing when such reviews exist). Do not translate the rest.';

// ---- validation ------------------------------------------------------------

const LabelSchema = z.object({
  idx: z.number().int(),
  sentiment: z.enum(['pos', 'neg', 'mixed']),
  sizing: z.enum(['runs_small', 'runs_large', 'true_to_size']).nullable().catch(null),
  heightCm: z.number().finite().nullish().catch(undefined),
  weightKg: z.number().finite().nullish().catch(undefined),
  sizeBought: z.string().nullish().catch(undefined),
});

const FlagSchema = z.object({
  group: z.enum(['fit', 'quality', 'shop']),
  text: z.string(),
  reviewIdx: z.array(z.number().int()).catch([]),
});

const TranslationSchema = z.object({ idx: z.number().int(), en: z.string() });

/** Parses each array entry on its own so one bad entry doesn't discard the rest. */
function parseEach<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S>[] {
  if (!Array.isArray(value)) return [];
  const out: z.infer<S>[] = [];
  for (const item of value) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

const phrases = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .slice(0, MAX_PHRASES);

export function emptyAnalysis(): ReviewAnalysis {
  return { labels: [], liked: [], disliked: [], flags: [], translations: {} };
}

/** Drops anything the model indexed outside [0, reviewCount); malformed entries are dropped, never thrown. */
export function validateAnalysis(raw: unknown, reviewCount: number): ReviewAnalysis {
  if (typeof raw !== 'object' || raw === null) return emptyAnalysis();
  const r = raw as Record<string, unknown>;
  const ok = (i: number) => i >= 0 && i < reviewCount;

  const seen = new Set<number>();
  const labels: ReviewLabel[] = [];
  for (const l of parseEach(LabelSchema, r.labels)) {
    if (!ok(l.idx) || seen.has(l.idx)) continue;
    seen.add(l.idx);
    const label: ReviewLabel = { idx: l.idx, sentiment: l.sentiment, sizing: l.sizing };
    if (l.heightCm != null) label.heightCm = l.heightCm;
    if (l.weightKg != null) label.weightKg = l.weightKg;
    if (l.sizeBought != null) label.sizeBought = l.sizeBought;
    labels.push(label);
  }

  const flags: ReviewFlag[] = [];
  for (const f of parseEach(FlagSchema, r.flags)) {
    const reviewIdx = [...new Set(f.reviewIdx.filter(ok))];
    if (reviewIdx.length > 0) flags.push({ group: f.group, text: f.text, reviewIdx });
  }

  const translations: Record<number, string> = {};
  let count = 0;
  for (const t of parseEach(TranslationSchema, r.translations)) {
    if (count >= MAX_TRANSLATIONS) break;
    if (!ok(t.idx) || t.idx in translations) continue;
    translations[t.idx] = t.en;
    count++;
  }

  return { labels, liked: phrases(r.liked), disliked: phrases(r.disliked), flags, translations };
}

// ---- model call ------------------------------------------------------------

export type ReviewsDeps = { call: typeof callStructured };

export async function analyzeReviews(
  reviews: Review[],
  product: ProductData,
  settings: Settings,
  deps: Partial<ReviewsDeps> = {},
): Promise<ReviewAnalysis> {
  if (reviews.length === 0) return emptyAnalysis();
  const call = deps.call ?? callStructured;

  const sent = reviews.slice(0, MAX_REVIEWS);
  const list = sent
    .map((rv, i) => `[${i}] (SKU: ${rv.sku ?? 'unknown'}) ${rv.text.slice(0, MAX_REVIEW_CHARS)}`)
    .join('\n');
  const intro = `Product title: ${product.title}\nSKU sizes: ${product.skuSizes.join(', ') || '(none)'}\n${sent.length} reviews follow.\n`;

  const raw = await call({
    settings,
    system: SYSTEM,
    content: [{ type: 'text', text: intro + list }],
    schema: ANALYZE_SCHEMA,
    maxTokens: 8192,
  });
  return validateAnalysis(raw, sent.length);
}
