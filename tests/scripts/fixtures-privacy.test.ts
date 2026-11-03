import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards every committed fixture against buyer/reviewer identity. Runs on whatever is in tests/fixtures
// (never raw/), so a regeneration that regresses fails CI.
const FIXTURES = resolve(__dirname, '../fixtures');
const FORBIDDEN_KEY = /nick|username|headpic|avatar|userflag|deliver|address|district|city|usersize|sizerecommend|userclick/;
const FORBIDDEN_VALUE = /userFlag=|userId=|uid=/i;

const sets = readdirSync(FIXTURES).filter((d) => d !== 'raw' && statSync(join(FIXTURES, d)).isDirectory());

function violations(value: unknown, path: string, allowSellerKeys: boolean, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => violations(v, `${path}[${i}]`, allowSellerKeys, out));
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const normalised = k.toLowerCase().replace(/[_-]/g, '');
      // The seller is a public shop: sellerNick is expected there.
      const exempt = path === '$.seller' && allowSellerKeys;
      if (!exempt && FORBIDDEN_KEY.test(normalised)) out.push(`key ${path}.${k}`);
      violations(v, `${path}.${k}`, allowSellerKeys, out);
    }
  } else if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) {
    out.push(`value at ${path}`);
  }
}

describe('committed fixtures contain no buyer or reviewer identity', () => {
  it('has the five expected fixture sets', () => {
    expect(sets.sort()).toEqual(['other', 'pants', 'shoes', 'tee', 'tmall']);
  });

  for (const set of sets) {
    for (const file of ['ssr.json', 'reviews.json', 'expected.json']) {
      it(`${set}/${file}`, () => {
        const path = join(FIXTURES, set, file);
        expect(existsSync(path)).toBe(true);
        const found: string[] = [];
        violations(JSON.parse(readFileSync(path, 'utf8')), '$', true, found);
        expect(found).toEqual([]);
      });
    }
  }
});
