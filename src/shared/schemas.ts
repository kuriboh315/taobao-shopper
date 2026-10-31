import { z } from 'zod';
import type { Profile } from './types';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const cm = z.number().min(5).max(300);
const heightCm = z.number().min(100).max(230);
const weightKg = z.number().min(25).max(250);

const WIDTH_TAGS = ['tight', 'fitted', 'just_right', 'relaxed', 'oversized'] as const;
const LENGTH_TAGS = ['too_short', 'slightly_short', 'just_right', 'slightly_long', 'too_long'] as const;
const FIT_PREFS = ['fitted', 'true_to_size', 'slightly_relaxed', 'oversized'] as const;

const widthMeasure = z.object({ value: cm, tag: z.enum(WIDTH_TAGS) }).strict();
const lengthMeasure = z.object({ value: cm, tag: z.enum(LENGTH_TAGS) }).strict();

const BodySchema = z.object({
  heightCm: heightCm.optional(),
  weightKg: weightKg.optional(),
  chest: cm.optional(),
  waist: cm.optional(),
  hips: cm.optional(),
  shoulder: cm.optional(),
  sleeve: cm.optional(),
  inseam: cm.optional(),
  thigh: cm.optional(),
  footLength: cm.optional(),
  shoeSizeEU: z.number().positive().optional(),
  shoeSizeCN: z.number().positive().optional(),
}).strict();

const RefGarmentSchema = z.object({
  label: z.string(),
  note: z.string().optional(),
  measures: z.object({
    chest: widthMeasure.optional(),
    waist: widthMeasure.optional(),
    hips: widthMeasure.optional(),
    thigh: widthMeasure.optional(),
    shoulder: widthMeasure.optional(),
    legOpening: widthMeasure.optional(),
    length: lengthMeasure.optional(),
    sleeve: lengthMeasure.optional(),
    inseam: lengthMeasure.optional(),
  }).strict(),
}).strict();

const ShoeRefSchema = z.object({
  label: z.string(),
  sizeEU: z.number().positive().optional(),
  sizeCN: z.number().positive().optional(),
  insoleCm: cm.optional(),
}).strict();

const FitPrefSchema = z.enum(FIT_PREFS);

export const ProfileSchema = z.object({
  body: BodySchema,
  garments: z.object({
    top: RefGarmentSchema.optional(),
    outerwear: RefGarmentSchema.optional(),
    bottom: RefGarmentSchema.optional(),
  }).strict(),
  shoe: ShoeRefSchema.optional(),
  prefs: z.object({
    top: FitPrefSchema,
    outerwear: FitPrefSchema,
    bottom: FitPrefSchema,
    shoe: FitPrefSchema,
  }).strict(),
}).strict();

export const SettingsSchema = z.object({
  apiKey: z.string(),
  model: z.string().min(1).default(DEFAULT_MODEL),
});

export const DEFAULT_PROFILE: Profile = {
  body: {},
  garments: {},
  prefs: { top: 'true_to_size', outerwear: 'true_to_size', bottom: 'true_to_size', shoe: 'true_to_size' },
};
