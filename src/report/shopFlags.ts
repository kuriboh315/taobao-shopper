import type { ProductData } from '../shared/types';
import type { Flag } from './build';

const SHOP_SOURCE = 'shop page';
const MIN_DSR = 4.6;
const MIN_SALES = 100;

/** "5 months" under a year, otherwise "3 years" / "2.5 years" (one decimal, no trailing .0). */
export function formatShopAge(ageYears: number): string {
  if (ageYears < 1) {
    const n = Math.round(ageYears * 12);
    return `${n} ${n === 1 ? 'month' : 'months'}`;
  }
  const y = Math.round(ageYears * 10) / 10;
  return `${y} ${y === 1 ? 'year' : 'years'}`;
}

/** Deterministic shop-trust flags from the shop page. */
export function shopFlags(product: ProductData): Flag[] {
  const flags: Flag[] = [];
  const add = (text: string) => flags.push({ group: 'shop', text, source: SHOP_SOURCE });
  const { dsr, ageYears } = product.shop;

  const rows: [string, number | undefined][] = [
    ['description', dsr?.description], ['service', dsr?.service], ['shipping', dsr?.shipping],
  ];
  for (const [name, v] of rows) if (v !== undefined && v < MIN_DSR) add(`Low ${name} rating (${v})`);

  if (ageYears !== undefined && ageYears < 1) {
    const n = Math.round(ageYears * 12);
    add(`Shop opened ${n} ${n === 1 ? 'month' : 'months'} ago`);
  }
  if (product.salesCount !== undefined && product.salesCount < MIN_SALES) add(`Few sales (${product.salesCount})`);
  return flags;
}
