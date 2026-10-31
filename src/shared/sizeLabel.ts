/** Normalise a size label so SKU names, chart rows and reviewer text compare equal. */
export function normalizeSizeLabel(s: string): string {
  const t = s
    .replace(/【[^】]*】|\([^)]*\)|（[^）]*）/g, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  if (t === '均码') return t;
  const u = t.replace(/码/g, '');
  const m = /^([2-9])XL$/.exec(u);
  return m ? 'X'.repeat(Number(m[1])) + 'L' : u;
}
