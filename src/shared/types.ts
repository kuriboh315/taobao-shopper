export type Category = 'top' | 'outerwear' | 'bottom' | 'shoe' | 'other';
export type WidthKey = 'chest' | 'waist' | 'hips' | 'thigh' | 'shoulder' | 'legOpening';
export type LengthKey = 'length' | 'sleeve' | 'inseam';
export type MeasureKey = WidthKey | LengthKey | 'footLength';
export type WidthTag = 'tight' | 'fitted' | 'just_right' | 'relaxed' | 'oversized';
export type LengthTag = 'too_short' | 'slightly_short' | 'just_right' | 'slightly_long' | 'too_long';
export type FitPref = 'fitted' | 'true_to_size' | 'slightly_relaxed' | 'oversized';

export interface Body { heightCm?: number; weightKg?: number; chest?: number; waist?: number; hips?: number;
  shoulder?: number; sleeve?: number; inseam?: number; thigh?: number; footLength?: number;
  shoeSizeEU?: number; shoeSizeCN?: number; }
export interface RefMeasure { value: number; tag: WidthTag | LengthTag }
export interface RefGarment { label: string; note?: string; measures: Partial<Record<Exclude<MeasureKey,'footLength'>, RefMeasure>> }
export interface ShoeRef { label: string; sizeEU?: number; sizeCN?: number; insoleCm?: number }
export interface Profile { body: Body; garments: { top?: RefGarment; outerwear?: RefGarment; bottom?: RefGarment };
  shoe?: ShoeRef; prefs: Record<'top' | 'outerwear' | 'bottom' | 'shoe', FitPref> }
export interface Settings { apiKey: string; model: string; fallbackCnyToCad?: number }
export interface FxRate { cnyToCad: number; date: string /* YYYY-MM-DD */; source: 'ecb' | 'manual' }

export interface ChartRow { label: string; measures: Partial<Record<MeasureKey, number>> } // cm, full circumference
export interface HwRow { label: string; heightMin?: number; heightMax?: number; weightMinKg?: number; weightMaxKg?: number }
export interface SizeChart { found: boolean; category: Category; rows: ChartRow[]; hwTable: HwRow[] }

export interface ProductData { itemId: string; title: string; priceText?: string;
  price?: { min: number; max: number; coupon?: number }; // CNY; min = max for a single price; coupon = 券后 price
  skuSizes: string[];
  salesText?: string; salesCount?: number;
  shop: { name?: string; dsr?: { description?: number; service?: number; shipping?: number }; ageYears?: number; extra: string[] };
  sizeGuideText?: string; images: { main: string[]; sku: string[]; detail: string[] } }
export interface Review { id: string; text: string; sku?: string; date?: string }

export type Sizing = 'runs_small' | 'runs_large' | 'true_to_size';
export interface ReviewLabel { idx: number; sentiment: 'pos' | 'neg' | 'mixed'; sizing: Sizing | null;
  heightCm?: number; weightKg?: number; sizeBought?: string }
export interface ReviewFlag { group: 'fit' | 'quality' | 'shop'; text: string; reviewIdx: number[] }
export interface ReviewAnalysis { labels: ReviewLabel[]; liked: string[]; disliked: string[];
  flags: ReviewFlag[]; translations: Record<number, string> } // idx to English

export interface SizeFit { label: string; measures: Partial<Record<MeasureKey, number>>;
  deltas: Partial<Record<MeasureKey, number>>; note: string; detail: string[] }
export interface FitResult { basis: 'garment' | 'body' | 'shoe' | 'height_weight' | 'none';
  recommended: string | null; sizes: SizeFit[]; comparedAgainst: string }
