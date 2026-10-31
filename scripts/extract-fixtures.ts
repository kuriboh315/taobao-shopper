// Extracts sanitized API response bodies from a browser HAR export.
// Usage: npx tsx scripts/extract-fixtures.ts <in.har> <outdir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// TODO(later task): the canonical list moves to src/collect/endpoints.ts.
export const DEFAULT_API_PATTERNS: RegExp[] = [
  /mtop\.taobao\.pcdetail\.data\.get/i,
  /mtop\.taobao\.rate\.detaillist\.get/i,
];

export interface ExtractedResponse {
  api: string;
  url: string;
  body: unknown;
}

const harSchema = z.object({
  log: z.object({
    entries: z.array(
      z.object({
        request: z.object({ url: z.string() }).loose(),
        response: z
          .object({
            content: z.object({ text: z.string().optional(), encoding: z.string().optional() }).loose().optional(),
          })
          .loose()
          .optional(),
      }),
    ),
  }),
});

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  // JSONP: callback({...}) with optional trailing semicolon
  const jsonp = /^[\w$.]+\(([\s\S]*)\)\s*;?$/.exec(trimmed);
  return JSON.parse(jsonp ? (jsonp[1] ?? '') : trimmed);
}

/** Returns response bodies for entries whose URL matches a pattern. Request headers, cookies and query strings are never copied. */
export function extractFromHar(har: unknown, apiPatterns: RegExp[]): ExtractedResponse[] {
  const parsed = harSchema.parse(har);
  const results: ExtractedResponse[] = [];
  for (const entry of parsed.log.entries) {
    const rawUrl = entry.request.url;
    const pattern = apiPatterns.find((p) => p.test(rawUrl));
    if (!pattern) continue;
    const content = entry.response?.content;
    if (!content?.text) continue;
    const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    let body: unknown;
    try {
      body = parseBody(text);
    } catch {
      continue;
    }
    const url = rawUrl.split(/[?#]/)[0] ?? rawUrl;
    const api = /mtop\.[\w.]+/i.exec(url)?.[0]?.toLowerCase().replace(/\.$/, '') ?? pattern.source;
    results.push({ api, url, body });
  }
  return results;
}

function main(): void {
  const [inFile, outDir] = process.argv.slice(2);
  if (!inFile || !outDir) {
    console.error('Usage: npx tsx scripts/extract-fixtures.ts <in.har> <outdir>');
    process.exit(1);
  }
  const results = extractFromHar(JSON.parse(readFileSync(inFile, 'utf8')), DEFAULT_API_PATTERNS);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'responses.json'), JSON.stringify(results, null, 2));
  const apis = [...new Set(results.map((r) => r.api))];
  console.log(`Wrote ${results.length} responses (${apis.join(', ') || 'none'}) to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
