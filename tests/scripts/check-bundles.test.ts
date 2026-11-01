import { describe, it, expect } from 'vitest';
import { moduleSyntax } from '../../scripts/check-bundles';

describe('moduleSyntax', () => {
  it('flags ES import/export statements', () => {
    expect(moduleSyntax('import { a } from "./x.js";\nfoo();')).toEqual(['import { a } from "./x.js";']);
    expect(moduleSyntax('import "./side.js";')).toHaveLength(1);
    expect(moduleSyntax('const a = 1;\nexport { a };')).toEqual(['export { a };']);
    expect(moduleSyntax('foo();\nimport("./lazy.js");')).toEqual(['import("./lazy.js");']);
  });

  it('accepts a classic IIFE script', () => {
    expect(moduleSyntax('(function() {\n  "use strict";\n  const important = 1;\n  // import later\n})();\n')).toEqual([]);
  });
});
