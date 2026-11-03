// Fails the build if a content-script bundle contains ES module syntax (content scripts run as classic scripts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUNDLES = ['dist/hook.js', 'dist/content.js'];
const MODULE_LINE = /^\s*(?:import\s*[\s{*"'(]|export\s)/;

/** Lines that use ES module syntax (static/dynamic import, export). */
export function moduleSyntax(code: string): string[] {
  return code.split('\n').filter((line) => MODULE_LINE.test(line)).map((line) => line.trim());
}

function main(): void {
  let failed = false;
  for (const file of BUNDLES) {
    const hits = moduleSyntax(readFileSync(resolve(file), 'utf8'));
    if (hits.length > 0) {
      failed = true;
      console.error(`${file} is not a classic script:\n  ${hits.join('\n  ')}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`check-bundles: ${BUNDLES.join(', ')} are self-contained classic scripts`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
