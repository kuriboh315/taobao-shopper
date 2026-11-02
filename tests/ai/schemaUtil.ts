import { expect } from 'vitest';

/** Asserts every object node has additionalProperties:false and lists all its properties in `required`. */
export function expectStrictObjectSchemas(node: unknown, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => expectStrictObjectSchemas(n, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const o = node as Record<string, unknown>;
  const isObject = o.type === 'object' || (Array.isArray(o.type) && o.type.includes('object'));
  if (isObject) {
    expect(o.additionalProperties, `${path}.additionalProperties`).toBe(false);
    const props = Object.keys((o.properties as object | undefined) ?? {});
    expect([...((o.required as string[] | undefined) ?? [])].sort(), `${path}.required`).toEqual([...props].sort());
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      for (const [pk, pv] of Object.entries(v)) expectStrictObjectSchemas(pv, `${path}.properties.${pk}`);
    } else if (typeof v === 'object') {
      expectStrictObjectSchemas(v, `${path}.${k}`);
    }
  }
}
