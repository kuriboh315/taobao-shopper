# Taobao Shopper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome extension that reads a Chinese Taobao product page in the user's logged-in browser and shows an English side-panel report covering the recommended size and how it fits, review sentiment, red flags, and shop stats.

**Architecture:**
- **Collection.** A MAIN-world content script records the JSON responses the Taobao page already fetches for itself (product data, reviews). An isolated content script drives review loading at a human pace and watches for captchas.
- **Analysis.** The side panel page orchestrates the run. It fetches and tiles images, then calls Claude twice: once to read the size chart and once to analyse the reviews. Every size decision, count and flag threshold is computed in pure TypeScript.
- **Rendering.** The panel renders a single scrolling report with jump-link tabs.
- **Background.** The service worker only wires the toolbar button to the side panel.

**Tech Stack:** TypeScript 5, Vite 6 (multi-entry build, no extension plugin), Vitest + jsdom, zod 3, `@anthropic-ai/sdk` (browser mode), Chrome MV3 Side Panel API. No UI framework.

**Spec:** `docs/superpowers/specs/2026-10-31-taobao-shopper-design.md`

## Global Constraints

- Chinese Taobao only. Content scripts match `https://item.taobao.com/item.htm*`. Host permissions are `https://item.taobao.com/*`, `https://*.alicdn.com/*` and `https://api.anthropic.com/*`.
- Analysis runs **only when the user clicks**. There are no background or automatic API calls.
- Review collection is careful:
  - collect about **40–80 reviews** (hard cap 80; fewer is fine if the page runs out)
  - randomised delay of **1500–4000 ms** between scroll/load actions
  - total collection time limit of **180 s**
  - on any captcha or verification signal, **stop immediately** and never try to solve or bypass it
- Fit maths is deterministic code. The model only extracts (chart table, per-review labels, translations) and never picks a size.
- Every review quote shown is the **verbatim collected Chinese text**, looked up by index in code, with a model-provided English translation.
- Never invent measurements. If no chart is found, say "No size chart found in the photos" and show no ★.
- Units: cm and kg internally. Convert inches (×2.54), mm (÷10) and 斤 (jin, ×0.5 kg) at the boundary.
- The default model is `claude-sonnet-5-5`, selectable in settings. The API key lives in `chrome.storage.local` only.
- CLAUDE.md rules:
  - source in `src/`, tests in `tests/`, scripts in `scripts/`
  - every file under 500 lines
  - validate at boundaries with zod (profile input, intercepted JSON, model output)
  - never commit secrets, `.har` files or `.env`
- Verify with `npm run build && npm test` before each commit.

## Review Focus

These five problems are the most likely to hurt a real user and are not covered by any task's main path. Each has a test in the task named.

1. **Flat-lay or non-cm charts.** Charts in 平铺 half-widths (胸宽 60), inches or mm must be normalised to full-circumference cm before fitting (Task 10, `normalizeChart` tests).
2. **Partly filled profile.** Examples: chest only, a garment value with no tag for one measure, or no body measurements at all. Sizing should use what exists, skip the rest, and never throw (Task 3/4 tests `partial profile`).
3. **Malformed or out-of-range model output.** Review indices that don't exist, negative or absurd cm values (<5 or >300), or an empty size label. These are dropped by validation, not rendered (Task 10/11 tests).
4. **Messy size labels.** `均码` (one size), `XL【建议130-150斤】`, `2XL` vs `XXL`, `S码`. Labels are normalised so chart rows match SKU options, and a one-size item shows its single row without a misleading comparison (Task 5 `normalizeSizeLabel` tests; Task 4 single-row test).
5. **Panel opened in the wrong place.** Non-Taobao tab, a logged-out page with no data, or a page with zero reviews. The panel shows a plain-English state with retry, never a blank panel or a thrown error (Task 13 tests).

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, vitest.config.ts, .gitignore
src/manifest.json
src/background/index.ts           service worker: open side panel on action click
src/shared/types.ts                all shared domain types (single source of truth)
src/shared/schemas.ts              zod schemas: Profile, Settings
src/profile/storage.ts             load/save profile, settings, report cache
src/options/options.html|ts|css    settings page (profile form, API key)
src/fit/ease.ts                    ease tables, length corrections, target computation
src/fit/engine.ts                  score sizes, recommend, per-size deltas
src/fit/notes.ts                   "Fit for you" note + detail lines
src/fit/fallbacks.ts               shoes, height/weight table, reviewer-stat matching
src/collect/endpoints.ts           mtop API name patterns + captcha signals (edit here when Taobao changes)
src/collect/hook.ts                MAIN-world fetch/XHR interceptor → window.postMessage
src/collect/parse.ts               intercepted JSON → ProductData / Review[] (zod-validated)
src/collect/dom.ts                 DOM selectors + fallbacks (edit here when Taobao changes)
src/collect/driver.ts              careful review loading loop, captcha pause
src/collect/content.ts             isolated content script: message handling, wiring
src/ai/images.ts                   fetch images, slice tall images into tiles
src/ai/client.ts                   Anthropic wrapper: forced-tool structured calls
src/ai/chart.ts                    locate + read size chart, normalise
src/ai/reviews.ts                  review analysis call + validation
src/report/build.ts                combine everything into a Report view-model
src/report/shopFlags.ts            rule-based shop-trust flags
src/panel/panel.html|ts|css        side panel shell, states, orchestration
src/panel/render.ts                Report → DOM
scripts/extract-fixtures.ts        HAR → sanitized JSON fixtures
tests/**                           mirrors src/
tests/fixtures/                    sanitized page data + hand-written *.expected.json
```

---

### Task 1: Scaffold, shared types, profile schema

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `src/manifest.json`, `src/background/index.ts`, `src/shared/types.ts`, `src/shared/schemas.ts`
- Test: `tests/shared/schemas.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`). Every later task imports these and nothing else defines them:

```ts
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
export interface Settings { apiKey: string; model: string }

export interface ChartRow { label: string; measures: Partial<Record<MeasureKey, number>> } // cm, full circumference
export interface HwRow { label: string; heightMin?: number; heightMax?: number; weightMinKg?: number; weightMaxKg?: number }
export interface SizeChart { found: boolean; category: Category; rows: ChartRow[]; hwTable: HwRow[] }

export interface ProductData { itemId: string; title: string; priceText?: string; skuSizes: string[];
  salesText?: string; salesCount?: number;
  shop: { name?: string; dsr?: { description?: number; service?: number; shipping?: number }; ageYears?: number; extra: string[] };
  sizeGuideText?: string; images: { main: string[]; sku: string[]; detail: string[] } }
export interface Review { id: string; text: string; sku?: string; date?: string }

export type Sizing = 'runs_small' | 'runs_large' | 'true_to_size';
export interface ReviewLabel { idx: number; sentiment: 'pos' | 'neg' | 'mixed'; sizing: Sizing | null;
  heightCm?: number; weightKg?: number; sizeBought?: string }
export interface ReviewFlag { group: 'fit' | 'quality' | 'shop'; text: string; reviewIdx: number[] }
export interface ReviewAnalysis { labels: ReviewLabel[]; liked: string[]; disliked: string[];
  flags: ReviewFlag[]; translations: Record<number, string> } // idx → English

export interface SizeFit { label: string; measures: Partial<Record<MeasureKey, number>>;
  deltas: Partial<Record<MeasureKey, number>>; note: string; detail: string[] }
export interface FitResult { basis: 'garment' | 'body' | 'shoe' | 'height_weight' | 'none';
  recommended: string | null; sizes: SizeFit[]; comparedAgainst: string }
```

- Produces (`src/shared/schemas.ts`): `ProfileSchema`, `SettingsSchema` (zod), `DEFAULT_PROFILE: Profile` with all prefs `true_to_size`, and `DEFAULT_MODEL = 'claude-sonnet-5-5'`.

- [ ] **Step 1: Init the repo and tooling.** Run `git init`. Create `package.json` with scripts `build` (`tsc --noEmit && vite build`), `test` (`vitest run`) and `dev` (`vite build --watch`). Add dependencies `zod`, `@anthropic-ai/sdk`, and devDependencies `typescript`, `vite`, `vitest`, `jsdom`, `@types/chrome`. Add `.gitignore` entries: `node_modules/`, `dist/`, `*.har`, `.env*`, `.superpowers/`, `.claude-flow/`, `tests/fixtures/raw/`.
- [ ] **Step 2: Configure the Vite build.** Set `build.rollupOptions.input` to `src/background/index.ts`, `src/collect/hook.ts`, `src/collect/content.ts`, `src/panel/panel.html` and `src/options/options.html`. Output to `dist/` with stable names: `background.js`, `hook.js`, `content.js`, `panel.html`, `options.html`. Copy `src/manifest.json` to `dist/` with a small inline plugin. Create empty placeholder entry files so the build passes.
- [ ] **Step 3: Write `src/manifest.json`.**
  - MV3 with `side_panel.default_path: "panel.html"` and `options_page: "options.html"`.
  - `permissions: ["sidePanel","storage","activeTab","tabs"]`, plus the host permissions from Global Constraints.
  - Two `content_scripts` on `https://item.taobao.com/item.htm*`: `hook.js` with `"world": "MAIN", "run_at": "document_start"`, and `content.js` with `"run_at": "document_idle"`.
  - `background.service_worker: "background.js"`.
  - `src/background/index.ts` calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.
- [ ] **Step 4: Write the failing schema tests** in `tests/shared/schemas.test.ts`:

```ts
it('accepts an empty profile', () => expect(ProfileSchema.parse(DEFAULT_PROFILE)).toEqual(DEFAULT_PROFILE));
it('rejects negative and absurd cm', () => {
  expect(() => ProfileSchema.parse({ ...DEFAULT_PROFILE, body: { chest: -5 } })).toThrow();
  expect(() => ProfileSchema.parse({ ...DEFAULT_PROFILE, body: { chest: 400 } })).toThrow();
});
it('requires a tag on each garment measure', () => {
  const p = { ...DEFAULT_PROFILE, garments: { top: { label: 'hoodie', measures: { chest: { value: 120 } } } } };
  expect(() => ProfileSchema.parse(p)).toThrow();
});
it('rejects a width tag on a length measure', () => {
  const p = { ...DEFAULT_PROFILE, garments: { top: { label: 'h', measures: { sleeve: { value: 62, tag: 'relaxed' } } } } };
  expect(() => ProfileSchema.parse(p)).toThrow();
});
it('defaults model', () => expect(SettingsSchema.parse({ apiKey: 'sk-ant-x' }).model).toBe('claude-sonnet-5-5'));
```

- [ ] **Step 5: Run the tests to confirm they fail.** Run `npx vitest run tests/shared`. Expected: FAIL (module not found).
- [ ] **Step 6: Implement `src/shared/types.ts` and `src/shared/schemas.ts`.** Use these cm bounds: 5–300 for measures, 100–230 for height, 25–250 kg for weight. Width keys accept only `WidthTag`; length keys accept only `LengthTag`.
- [ ] **Step 7: Verify.** Run `npm run build && npm test`. Expected: build succeeds and all tests pass. Load `dist/` unpacked in Chrome. Clicking the icon on any `item.taobao.com` page should open an empty side panel.
- [ ] **Step 8: Commit** with message `chore: scaffold extension, shared types, profile schema`.

---

### Task 2: Real-page fixtures (needs the user)

The page-reading code is test-first against real data, so this task comes before any collector work. The implementer needs the user's logged-in browser for it.

**Files:**
- Create: `scripts/extract-fixtures.ts`, `tests/fixtures/<name>/` (four sets), `tests/scripts/extract-fixtures.test.ts`

**Interfaces:**
- Produces: `extractFromHar(har: unknown, apiPatterns: RegExp[]): { api: string; url: string; body: unknown }[]`. Its output keeps response bodies only; it never includes request headers, cookies or query tokens.
- Produces these fixture sets: `tests/fixtures/{tee-with-chart, pants-no-chart, shoes, non-clothing}/`. Each set contains:
  - `responses.json` (the extractor output)
  - `page.html` (`document.documentElement.outerHTML` after the user has opened 全部评价 and scrolled once)
  - `detail-images/` (the first 30 detail images, used by the Task 10 eval script)
  - `expected.json`, written by hand from the visible page: title, skuSizes, salesText, DSR values, the first 3 review texts, and, for the chart page, the chart transcribed by hand

- [ ] **Step 1: Write the failing test.** Feed `extractFromHar` a hand-made HAR with two entries: one `mtop.taobao.pcdetail.data.get` with a cookie header and a JSONP body `mtopjsonp3({...})`, and one unrelated `.png`. Assert the result has length 1, `body` is the parsed object (JSONP wrapper stripped), and `JSON.stringify(result)` contains neither `cookie` nor `_m_h5_tk`.
- [ ] **Step 2: Run the test to confirm it fails.** Run `npx vitest run tests/scripts`. Expected: FAIL.
- [ ] **Step 3: Implement `extractFromHar`** plus a CLI wrapper: `npx tsx scripts/extract-fixtures.ts <in.har> <outdir>`. The default patterns are `/mtop\.taobao\.pcdetail\.data\.get/i` and `/mtop\.taobao\.rate\.detaillist\.get/i`. These are the expected names; confirm them in the HAR and add any others the page uses.
- [ ] **Step 4: Run the test to confirm it passes.** Run `npx vitest run tests/scripts`. Expected: PASS.
- [ ] **Step 5: Capture the fixtures with the user.** For each of the four product types:
  1. The user opens the item, opens DevTools → Network, opens 全部评价 and scrolls the reviews once.
  2. Save the network log as HAR with content into `tests/fixtures/raw/` (gitignored).
  3. Run the extractor.
  4. Save `page.html` from the console with `copy(document.documentElement.outerHTML)`.
  5. Download the detail images.
  6. Write `expected.json` by hand.

  Record the confirmed API names in a comment at the top of `src/collect/endpoints.ts` (create the file with the patterns only). Before committing, grep the fixtures for the user's Taobao nickname and replace it with `USER`.
- [ ] **Step 6: Commit** with message `test: add sanitized Taobao page fixtures and HAR extractor`. Do not commit `raw/`.

---

### Task 3: Ease tables and fit targets

**Files:**
- Create: `src/fit/ease.ts`
- Test: `tests/fit/ease.test.ts`

**Interfaces:**
- Consumes: the types from Task 1.
- Produces:
  - `STD_EASE: Record<WidthKey, Record<WidthTag, number>>`
  - `LENGTH_CORRECTION: Record<LengthTag, number>`
  - `PREF_TO_TAG: Record<FitPref, WidthTag>`
  - `garmentFor(profile: Profile, cat: Category): RefGarment | undefined`
  - `targets(profile: Profile, cat: Category): { basis: 'garment' | 'body' | 'none'; t: Partial<Record<MeasureKey, number>> }`
  - `easeLevel(key: WidthKey, ease: number): WidthTag`, which returns the nearest tag in `STD_EASE`; a tie resolves to the looser tag

**Pinned values.** These are body→garment circumference ease in cm. Spec §11 leaves them to the builder; they are fixed here so tests can pin them.

| key | tight | fitted | just_right | relaxed | oversized |
|---|---|---|---|---|---|
| chest | 2 | 6 | 10 | 16 | 24 |
| waist | -2 | 0 | 2 | 4 | 8 |
| hips | 0 | 4 | 8 | 12 | 18 |
| thigh | 2 | 4 | 8 | 12 | 16 |
| shoulder | -2 | 0 | 1 | 3 | 6 |
| legOpening | 0 | 0 | 0 | 0 | 0 (never targeted from body) |

- `LENGTH_CORRECTION`: too_short +4, slightly_short +2, just_right 0, slightly_long −2, too_long −4.
- `PREF_TO_TAG`: fitted→fitted, true_to_size→just_right, slightly_relaxed→relaxed, oversized→oversized.

**Target rules (spec §6):**
1. **Width key with a garment measure:** `garment.value + (STD_EASE[k][PREF_TO_TAG[pref]] − STD_EASE[k][garment.tag])`.
2. **Length key with a garment measure:** `garment.value + LENGTH_CORRECTION[tag]`. Fit preference does not change length.
3. **No garment measure for that key, but a body measure:**
   - width keys: `body[k] + STD_EASE[k][PREF_TO_TAG[pref]]`
   - `sleeve` and `inseam`: `body[k]`
   - `length`: untargeted
4. **Basis** is `'garment'` if any garment measure is used, else `'body'` if any body measure is used, else `'none'`.
5. **Category → garment and preference:** top→top. Outerwear→outerwear, else the top garment (with outerwear's own pref). Bottom→bottom. Shoe and other→none.

- [ ] **Step 1: Write the failing tests:**

```ts
const hoodie = { label: 'hoodie', measures: { chest: { value: 120, tag: 'relaxed' }, length: { value: 71, tag: 'just_right' }, sleeve: { value: 62, tag: 'slightly_long' } } };
it('garment tag equals pref → garment value', () =>
  expect(targets({ ...P, garments: { top: hoodie }, prefs: { ...P.prefs, top: 'slightly_relaxed' } }, 'top').t.chest).toBe(120));
it('pref looser than tag shifts by table step', () =>
  expect(targets({ ...P, garments: { top: hoodie }, prefs: { ...P.prefs, top: 'oversized' } }, 'top').t.chest).toBe(128));
it('slightly long sleeve → target shorter', () => expect(targets({ ...P, garments: { top: hoodie } }, 'top').t.sleeve).toBe(60));
it('body fallback', () => {
  const r = targets({ ...P, body: { chest: 108 }, prefs: { ...P.prefs, top: 'oversized' } }, 'top');
  expect(r).toEqual({ basis: 'body', t: { chest: 132 } });
});
it('outerwear falls back to top garment', () => expect(targets({ ...P, garments: { top: hoodie } }, 'outerwear').basis).toBe('garment'));
it('partial profile: nothing → none, no throw', () => expect(targets(P, 'bottom')).toEqual({ basis: 'none', t: {} }));
it('easeLevel nearest', () => { expect(easeLevel('chest', 14)).toBe('relaxed'); expect(easeLevel('chest', 30)).toBe('oversized'); });
it('easeLevel tie → looser', () => expect(easeLevel('chest', 8)).toBe('just_right'));
```

`P` is `DEFAULT_PROFILE`.

- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx vitest run tests/fit/ease.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/fit/ease.ts`** with the signatures and values above.
- [ ] **Step 4: Run the tests to confirm they pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(fit): ease tables and per-measure targets`.

---

### Task 4: Size scoring, recommendation and fit notes

**Files:**
- Create: `src/fit/engine.ts`, `src/fit/notes.ts`
- Test: `tests/fit/engine.test.ts`, `tests/fit/notes.test.ts`

**Interfaces:**
- Consumes: `targets`, `garmentFor`, `easeLevel` and `STD_EASE` from Task 3.
- Produces:
  - `recommend(chart: SizeChart, profile: Profile): FitResult`. It handles categories `top`, `outerwear` and `bottom`, and delegates `shoe` to `recommendShoe` (Task 5).
  - `noteFor(key, sizeValue, target, ctx): string`
  - `detailFor(...)`: string[]

**Scoring:**
- For each row: `score = Σ w_k · penalty(row[k] − t[k])` over the keys present in both row and targets.
- Weights: chest/waist **1.5**, other width keys **1.0**, length keys **0.7**.
- `penalty(d) = d < 0 ? 1.5·|d| : |d|`, so tighter or shorter is worse than looser.
- Lowest score wins. On a tie, the larger size (later row) wins.
- If no key overlaps, or basis is `'none'`, then `recommended = null` (Task 5's height/weight fallback takes over).
- With exactly one row (one size / 均码), still compute deltas and notes, but set `recommended` to that label only if at least one key overlapped.
- Rows keep chart order.

**Notes** (`note` is the short "Fit for you" cell):
- For the primary width key (chest for tops, waist for bottoms), compute `easeLevel` against the body measure when one exists; otherwise compare the delta to the garment.
- Map the level to a phrase: tight→"Tight", fitted→"Fitted", just_right→"Regular", relaxed→"Relaxed", oversized→"Oversized". If ease exceeds the oversized table value by more than 6, use "Very baggy".
- Then append each length key with |delta| > 2, as `", sleeves −2"` or `", length +3"`. Use names: length→"length", sleeve→"sleeves", inseam→"inseam".
- When the primary key has no target, the note is the length parts alone, or "—".

**Detail lines** (the per-measure comparison under the table, recommended size only; spec §6 point 4):
- With a garment: `"chest 2 cm roomier than your hoodie (relaxed → a bit oversized)"`, `"sleeves same as your hoodie (which you find slightly long)"`.
- "same" means |Δ| ≤ 1.
- Words: roomier/tighter for width keys, longer/shorter for length keys.
- With body only: `"chest +14 cm vs your body"`.

`comparedAgainst`:
- garment and body: `"vs your body (chest 108) and your hoodie (chest 120, length 71)"`
- body only: `"vs your body (chest 108)"`
- garment only: `"vs your hoodie (chest 120, length 71)"`

- [ ] **Step 1: Write the failing tests.** Chart rows are L{chest 116, length 70, sleeve 60}, XL{122, 72, 62} and XXL{128, 74, 63}. Profile: body chest 108, hoodie as in Task 3.
  - With pref `slightly_relaxed`, expect `recommended` `'XL'`.
  - With pref `oversized`, expect `'XXL'`.
  - With pref `slightly_relaxed`, the notes are: L `'Regular'` (ease 8, tie → looser), XL `'Relaxed'` (ease 14), XXL `'Oversized, sleeves +3'` (ease 20, tie → looser; sleeve 63 vs target 60).
  - With pref `slightly_relaxed`, the scores are L 10.05, XL 5.1. Assert XL's score is lower than L's (expose `score` on an internal helper or check through `recommended`).
  - Expect `comparedAgainst` `'vs your body (chest 108) and your hoodie (chest 120, length 71)'`.
  - **Tie test:** two rows with equal score, so the later one wins.
  - **Partial profile:** only `body.waist = 80` with a top chart gives `recommended === null` and notes `'—'`, without throwing.
  - **Single row** `均码` with chest 140 and only body chest 108 (ease 32 > 24 + 6) gives `recommended '均码'` and note `'Very baggy'`.
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `recommend` in `engine.ts` and the note/detail builders in `notes.ts`.** `engine.ts` calls `notes.ts`, never the other way round.
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(fit): size scoring, recommendation, fit notes`.

---

### Task 5: Shoes, height/weight fallback and reviewer-stat matching

**Files:**
- Create: `src/fit/fallbacks.ts`, `src/shared/sizeLabel.ts`
- Test: `tests/fit/fallbacks.test.ts`, `tests/shared/sizeLabel.test.ts`

**Interfaces:**
- Produces `normalizeSizeLabel(s: string): string` in `src/shared/sizeLabel.ts`:
  - uppercase
  - strip whitespace, `码`, and bracketed text `【…】(…)（…）`
  - map `2XL→XXL`, `3XL→XXXL`, `4XL→XXXXL`
  - keep `均码` as is

  Tests: `'XL【建议130-150斤】'` → `'XL'`, `'2XL'` → `'XXL'`, `'S码'` → `'S'`, `'均码'` → `'均码'`. Task 10 and Task 12 import it from here.
- Produces:
  - `recommendShoe(chart: SizeChart, profile: Profile): FitResult`
  - `pickFromHwTable(hw: HwRow[], body: Body): string | null`
  - `nearbyReviewers(labels: ReviewLabel[], body: Body): { sizeBought: string; count: number; sizing: Record<Sizing, number> }[]`
- `recommend` (Task 4) calls `recommendShoe` when `chart.category === 'shoe'`.

**Rules:**
- **Shoe with chart `footLength` and body `footLength`:**
  - allowance by pref: fitted 0.5, true_to_size 0.8, slightly_relaxed 1.0, oversized 1.5 (cm)
  - pick the smallest row whose `footLength ≥ body.footLength + allowance`
  - basis `'shoe'`; note `"+{row.footLength − body.footLength} cm room"`
- **Otherwise, with the profile's `shoeSizeEU`/`shoeSizeCN` (or the shoe ref's sizes):** pick the row whose label equals that size after `normalizeSizeLabel` (defined in this task, see below). Note `"your usual size"`.
- **Otherwise:** `recommended: null`.
- **`pickFromHwTable`:** prefer a row containing both height and weight. If several rows contain one each, pick the largest row (last in table order) among those matching weight. If height or weight is missing, match on the one present. If nothing matches, return null.
- **`nearbyReviewers`:** keep labels with `|height − body.heightCm| ≤ 3` **and** `|weight − body.weightKg| ≤ 3` (both must be present on the label and body). Group by `sizeBought`, sort by count descending.

- [ ] **Step 1: Write the failing tests.**
  - Foot 25.5, pref true_to_size, rows 40{25.5} 41{26} 42{26.5}: the threshold is 26.3, so expect `'42'` with note `'+1 cm room'`.
  - EU 42 profile with no foot length: expect `'42'`.
  - HW table [{M, 165–175, 55–65}, {L, 170–180, 60–70}] with body 175/68: expect `'L'`.
  - Body 175/62: both rows contain both values, so the last (larger) row wins → `'L'`.
  - No height or weight: expect `null`.
  - `nearbyReviewers` drops labels missing weight, and groups two XL and one L correctly.
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `src/fit/fallbacks.ts`** and wire the `shoe` branch into `recommend`.
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(fit): shoe sizing, height/weight and reviewer fallbacks`.

---

### Task 6: Storage and settings page

**Files:**
- Create: `src/profile/storage.ts`, `src/options/options.html`, `src/options/options.ts`, `src/options/options.css`
- Test: `tests/profile/storage.test.ts`, `tests/options/options.test.ts` (jsdom)

**Interfaces:**
- Produces:
  - `loadProfile(): Promise<Profile>` (returns `DEFAULT_PROFILE` when empty or invalid)
  - `saveProfile(p: Profile): Promise<void>` (validates first, throws a `ZodError` on invalid input)
  - `loadSettings(): Promise<Settings | null>`
  - `saveSettings(s: Settings): Promise<void>`
  - `getCachedReport(itemId: string): Promise<CachedRun | null>`
  - `putCachedReport(itemId: string, run: CachedRun): Promise<void>`

  `CachedRun = { at: number; product: ProductData; reviews: Review[]; chart: SizeChart; analysis: ReviewAnalysis | null }`. The cache stores inputs, not fit results; fit is recomputed from the current profile on every render. Keep at most 50 items, evicting the oldest.
- Storage is `chrome.storage.local`, keys `profile`, `settings` and `cache:<itemId>`. Tests use an in-memory stub of `chrome.storage.local`.

**Settings page content:**
- **Body section:** every `Body` field, as number inputs with a "cm"/"kg" suffix.
- **Garment sections** for Top, Outerwear (optional; the hint says "uses Top if empty") and Bottom:
  - a label input and a note input
  - for each measure: a value input plus a tag `<select>` (width tags or length tags as appropriate)
  - the tag select is only required when a value is entered
- **Shoe section:** label, EU, CN, insole.
- **Fit preference** select per category.
- **API section:** key (password input), model (text input, default `claude-sonnet-5-5`).
- **Save button**, showing inline validation messages next to the offending field.

Measuring hints, fixed copy:
- Body chest: "Measure around the fullest part of your chest, tape level."
- Garment chest: "Lay flat, measure armpit to armpit, then double it. Taobao charts list garment measurements, not body measurements."
- Garment length: "From the highest point of the shoulder to the hem."
- Garment sleeve: "From the shoulder seam to the cuff."
- Garment waist: "Lay flat, measure across the waistband, then double it."
- Garment inseam: "From the crotch seam to the hem."
- Foot length: "Heel to longest toe, standing."

- [ ] **Step 1: Write the failing tests.**
  - `saveProfile` then `loadProfile` round-trips.
  - Invalid stored data loads as `DEFAULT_PROFILE`.
  - The cache evicts the oldest after 50 entries.
  - In jsdom: filling chest 120 without a tag and pressing Save shows the message "Choose how this fits you" next to that row and does not call `saveProfile`.
  - Filling all fields and saving produces the expected `Profile` object (via a form→Profile function `readForm(root: HTMLElement): Profile` exported from `options.ts`).
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement storage, then the options page.** Generate the form from a field-definition array so it stays under 500 lines. Export `readForm` and `fillForm(root, profile)`.
- [ ] **Step 4: Run the tests to confirm they pass, then build.** Run `npm run build && npm test`. Expected: PASS. Opening extension options shows the form, and a saved value survives a reload.
- [ ] **Step 5: Commit** with message `feat: profile storage and settings page`.

---

### Task 7: Page data interception and parsing

**Files:**
- Create: `src/collect/hook.ts`, `src/collect/parse.ts`, `src/collect/dom.ts` (product-field fallbacks only)
- Modify: `src/collect/endpoints.ts`
- Test: `tests/collect/parse.test.ts`, `tests/collect/dom.test.ts`

**Interfaces:**
- `endpoints.ts` produces:
  - `API_PATTERNS: { product: RegExp[]; reviews: RegExp[] }`
  - `CAPTCHA_RET_CODES = ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR']`
  - `CAPTCHA_SELECTORS = ['#baxia-dialog-content', 'iframe[src*="punish"]', '.nc-container', '#nc_1_wrapper']`
  - `CAPTCHA_URL = /_____tmd_____\/punish/`
- `hook.ts` (MAIN world) wraps `window.fetch` and `XMLHttpRequest`. For responses whose URL matches any pattern, it posts `{ source: 'tbs-hook', kind: 'product' | 'reviews', url, body }` via `window.postMessage`, with the JSONP wrapper stripped. It never modifies or issues requests itself.
- `parse.ts` produces:
  - `parseProduct(bodies: unknown[], itemId: string): ProductData`
  - `parseReviews(bodies: unknown[]): Review[]` (deduped by id, empty texts and the default "此用户没有填写评价" dropped)
  - `isCaptchaResponse(body: unknown): boolean`
  - all three are zod-validated with `.passthrough()`, and missing fields become `undefined`, never throw
- `dom.ts` produces `productFromDom(doc: Document): Partial<ProductData>`. It is used to fill whatever `parseProduct` left empty: title, salesText, shop DSR, and detail image URLs from the lazy-load attributes (`data-src`, `data-ks-lazyload`, `src`).
- `salesCount`: parse `"已售 1万+"` → 10000, `"月销 3000+"` → 3000, `"已售 512"` → 512.
- Image URLs: normalise protocol-relative `//img.alicdn.com/...` to `https:`, and strip thumbnail suffixes like `_60x60q90.jpg` to get the full image.

- [ ] **Step 1: Write the failing tests** against all four fixture sets. For each set, `parseProduct(responses.filter(product))` merged with `productFromDom(page.html)`:
  - deep-equals the fixture's `expected.json` on title, skuSizes, salesText and DSR
  - has ≥ 5 detail image URLs, all starting with `https://`

  Plus:
  - `parseReviews` returns the expected first three review texts in order.
  - `isCaptchaResponse({ ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦'] })` is true.
  - `parseProduct([], 'x')` returns `{ itemId: 'x', title: '', skuSizes: [], images: {main:[],sku:[],detail:[]}, shop: { extra: [] } }` without throwing.
  - The `salesCount` parsing cases above pass.
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement the four files.** Take field paths from the fixtures, and keep every selector and JSON path in `parse.ts`/`dom.ts` as named constants at the top of the file.
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(collect): intercept and parse product and review data`.

---

### Task 8: Careful review driver and content script

**Files:**
- Create: `src/collect/driver.ts`, `src/collect/content.ts`
- Modify: `src/collect/dom.ts` (add the review-view selectors)
- Test: `tests/collect/driver.test.ts` (fake timers, fake DOM)

**Interfaces:**
- Consumes: `parseReviews`, `isCaptchaResponse`, `CAPTCHA_*`, `productFromDom`, `parseProduct`.
- Produces the **message protocol** over a `chrome.runtime` port named `"tbs"`, from panel to content script:
  - panel → content: `{ type: 'collect' }`, `{ type: 'resume' }`, `{ type: 'finish' }`
  - content → panel:
    - `{ type: 'progress', reviews: number }`
    - `{ type: 'captcha' }`
    - `{ type: 'done', product: ProductData, reviews: Review[], stoppedBy: 'cap' | 'exhausted' | 'timeout' | 'user' }`
    - `{ type: 'error', message: string }`
- Produces `class ReviewDriver { constructor(deps: DriverDeps); run(): Promise<StopReason>; resume(): void; finish(): void }`. `DriverDeps = { openReviews(): Promise<boolean>; loadMore(): Promise<boolean>; count(): number; captchaVisible(): boolean; sleep(ms: number): Promise<void>; random(): number; now(): number; onProgress(n: number): void; onCaptcha(): void }`. Injecting the dependencies keeps it testable.
- `dom.ts` adds:
  - `openReviewsView(doc): Promise<boolean>`, which clicks the element whose text matches `/全部评价|查看全部评价|宝贝评价/`
  - `scrollReviewsOnce(doc): Promise<boolean>`, which scrolls the review container by 0.8× its height and returns false when the bottom is reached and no new items arrive
  - `captchaVisible(doc): boolean`

**Loop:**
1. Open reviews.
2. Then repeat:
   - check the captcha state; if found, call `onCaptcha` and wait until `resume()` or `finish()`
   - stop with `'cap'` when `count() ≥ 80`; stop with `'exhausted'` when `loadMore()` returns false twice in a row (at any count, because the source has nothing more)
   - stop when 180 s have elapsed
   - otherwise `sleep(1500 + random()·2500)`, then `loadMore()`
3. Captcha comes from either the DOM (`captchaVisible`) or an intercepted response (`isCaptchaResponse`). It is checked **before** every action.

- [ ] **Step 1: Write the failing tests:**
  - stops with `'cap'` when the count reaches 80
  - stops with `'exhausted'` after two failed loads at ≥ 40
  - below 40 with two failed loads, also stops `'exhausted'` (the source has nothing more)
  - stops with `'timeout'` at 180 s
  - every sleep is between 1500 and 4000 ms
  - when `captchaVisible` turns true, `loadMore` is **not** called again until `resume()`, and `onCaptcha` is called exactly once
  - `finish()` during a captcha pause returns `'user'`
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `ReviewDriver`, then `content.ts`.** The content script:
  - buffers `tbs-hook` messages
  - on `collect`, runs the driver with real deps
  - builds `ProductData` from parsed responses plus DOM fallback, and `Review[]` from parsed responses
  - posts `done`

  If the page has no product data and no title, post `error` with "Couldn't read this page. Make sure you're logged in to Taobao and the product page has fully loaded."
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Manual check on the user's browser.** Loading a real item and sending `collect` from a temporary panel button should show the progress count rising at a visibly human pace, and `done` should arrive with 40–80 reviews.
- [ ] **Step 6: Commit** with message `feat(collect): careful review driver with captcha pause`.

---

### Task 9: Image fetching and tiling

**Files:**
- Create: `src/ai/images.ts`
- Test: `tests/ai/images.test.ts` (tests the pure tiling geometry)

**Interfaces:**
- Produces:
  - `tileRects(w: number, h: number, maxEdge = 1568, overlap = 120): { x: number; y: number; w: number; h: number }[]`
  - `fetchTiles(urls: string[], opts: { maxEdge: number; maxTiles: number }): Promise<Tile[]>`, where `Tile = { src: string; index: number; tile: number; media_type: 'image/jpeg'; data: string /* base64 */ }`
- `fetchTiles` runs in the panel page. It uses `fetch` (host permission on alicdn), `createImageBitmap`, and an `OffscreenCanvas` that crops each rect and scales it so the long edge ≤ `maxEdge`. It encodes JPEG at quality 0.85 and stops at `maxTiles`.
- **Geometry:** width is kept whole. Strip height = `Math.min(h, Math.round(w * 1.4))`, with `overlap` px between consecutive strips, so a chart cut at one boundary still appears whole in a neighbouring tile. Each strip is then scaled so its long edge ≤ `maxEdge`.

- [ ] **Step 1: Write the failing tests:**
  - `tileRects(790, 900)` gives one rect.
  - `tileRects(790, 5000)` gives rects covering y = 0..5000 with each `h ≤ 1106` and consecutive rects overlapping by 120.
  - The last rect ends exactly at 5000.
  - All widths equal 790.
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `tileRects` and `fetchTiles`.** A failed fetch for one URL is skipped and logged; it never fails the run.
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(ai): image fetching and tall-image tiling`.

---

### Task 10: Claude client and size-chart reading

**Files:**
- Create: `src/ai/client.ts`, `src/ai/chart.ts`, `scripts/eval-chart.ts`
- Test: `tests/ai/chart.test.ts` (mocked client)

**Interfaces:**
- `client.ts` produces `callTool<T>(args: { settings: Settings; system: string; content: ContentBlock[]; tool: { name: string; description: string; input_schema: object }; maxTokens: number }): Promise<unknown>`.
  - It uses `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`, `messages.create` with `tool_choice: { type: 'tool', name }`, and returns the tool_use `input`.
  - It maps errors to plain English:
    - 401 → "Your Anthropic API key was rejected. Check it in Settings."
    - 429 → "Anthropic rate limit hit. Wait a minute and retry."
    - network → "Couldn't reach Anthropic. Check your connection."
- `chart.ts` produces:
  - (imports `normalizeSizeLabel` from `src/shared/sizeLabel.ts`, Task 5)
  - `normalizeChart(raw: unknown, skuSizes: string[]): SizeChart` (zod-validated)
  - `readSizeChart(product: ProductData, settings: Settings, onProgress: (msg: string) => void): Promise<SizeChart>`

**`readSizeChart` runs in two passes, to keep the cost cap:**
1. **Locate.** Tiles of all detail images + SKU images at `maxEdge 512`, capped at **40 tiles**, sent in one call. Tool `locate_size_chart` returns:
   - `{ tiles: number[] /* indices containing a size table or height/weight table */, category: Category }`
   - The prompt also includes the title, SKU sizes and `sizeGuideText`.
2. **Read.** Only those tiles, re-fetched at `maxEdge 1568`, capped at **6 tiles**. Tool `read_size_chart` returns:
   - `{ found: boolean, unit: 'cm'|'inch'|'mm', rows: [{ label, measures: [{ name_zh, key: MeasureKey|null, value: number, basis: 'circumference'|'flat' }] }], hw: [{ label, heightMin?, heightMax?, weightMin?, weightMax?, weightUnit: 'kg'|'jin' }] }`
   - The system prompt says: transcribe only what is printed; never estimate; set `found: false` if no table is legible. It includes the key mapping:

     胸围→chest, 衣长/后中长/裤长→length, 肩宽→shoulder, 袖长→sleeve, 腰围→waist, 臀围→hips, 大腿围/腿围→thigh, 脚口/裤脚→legOpening, 内长/内裆长→inseam, 脚长/内长(鞋)→footLength. 胸宽/平铺 marks a flat measure.

   If pass 1 returns no tiles, skip pass 2 and return `{ found: false, category, rows: [], hwTable: [] }`.

**`normalizeChart`:**
- converts inch → ×2.54 and mm → ÷10, rounding to 0.5 cm
- doubles `flat` values for `chest|waist|hips|thigh|legOpening`
- also doubles any chest < 70 or waist < 50 that is labelled circumference (a mislabelled flat lay)
- drops values outside 5–300 cm and measures with `key: null`
- drops rows with an empty label
- converts jin → ÷2
- `found` becomes false if no rows remain
- reorders rows to match the `skuSizes` order where labels match

- [ ] **Step 1: Write the failing tests:**
  - `normalizeChart`:
    - a flat chest 60 → 120
    - a chest of 47 inches → 119.5
    - 1100 mm → 110
    - hw 130–150 jin → 65–75 kg
    - a row with chest −3 loses that measure
    - an empty label row is dropped
    - all rows invalid → `found: false`
  - `readSizeChart` with a mocked `callTool`:
    - pass 1 returns `tiles: []`, so pass 2 is never called and `found` is false
    - pass 1 returns `[3,4]`, so pass 2 receives exactly 2 image blocks
  - `callTool` maps a 401 to the exact settings message.
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `client.ts` and `chart.ts`.** Tile fetching goes through `fetchTiles` (Task 9).
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Live evaluation (manual, uses the user's key).** Run `ANTHROPIC_API_KEY=... npx tsx scripts/eval-chart.ts tests/fixtures/tee-with-chart` against the fixture images. It should print the normalised chart and a diff against `expected.json`. Expected: every size and measure matches within 0.5 cm, and `pants-no-chart` prints `found: false`. Tune the prompts until both hold. Record the approximate cost per run that the script prints from `usage`; it must be a few cents.
- [ ] **Step 6: Commit** with message `feat(ai): two-pass size chart reading with normalisation`.

---

### Task 11: Review analysis

**Files:**
- Create: `src/ai/reviews.ts`
- Test: `tests/ai/reviews.test.ts`

**Interfaces:**
- Consumes `callTool`.
- Produces:
  - `analyzeReviews(reviews: Review[], product: ProductData, settings: Settings): Promise<ReviewAnalysis>`
  - `validateAnalysis(raw: unknown, reviewCount: number): ReviewAnalysis`
- One call. Reviews are sent as a numbered list `[i] (SKU: …) text`. Tool `analyze_reviews` returns:
  - `labels` (one per review, with `sizing` set only when the review talks about fit, and `heightCm`/`weightKg`/`sizeBought` extracted when stated; 斤 converted ÷2)
  - `liked` and `disliked` (≤ 5 short English phrases each)
  - `flags` (group, English text, `reviewIdx[]`), for:
    - fit complaints and quality issues (pilling, thin, smell, fading, loose threads, colour mismatch)
    - shop-trust review patterns: near-identical short reviews, 好评返现/cashback mentions
  - `translations` (English for up to **8** indices the model judges most representative, at least 3 of which are sizing-related when such reviews exist)
- **`validateAnalysis`:**
  - drops labels, flag indices and translations whose idx is `< 0` or `≥ reviewCount`
  - drops flags left with no indices
  - dedupes labels by idx (first wins)
  - caps liked/disliked at 5

  Quotes are rendered later from `reviews[idx].text`, so the Chinese is always verbatim.
- Zero reviews: no API call; return an empty analysis.

- [ ] **Step 1: Write the failing tests:**
  - `validateAnalysis` with `reviewCount 3`:
    - drops `labels[idx 7]`
    - drops a flag whose only idx is 9
    - keeps a flag with idx [0, 9] as [0]
    - drops translation key 5
  - Duplicate label idx keeps the first.
  - `analyzeReviews([], …)` resolves without calling `callTool` (spy).
  - The prompt payload contains `[0]` and the SKU text for the first review.
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `src/ai/reviews.ts`.**
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(ai): review analysis with index-validated output`.

---

### Task 12: Report builder and shop-trust rules

**Files:**
- Create: `src/report/build.ts`, `src/report/shopFlags.ts`
- Test: `tests/report/build.test.ts`, `tests/report/shopFlags.test.ts`

**Interfaces:**
- Consumes: `recommend`, `pickFromHwTable`, `nearbyReviewers`, `normalizeSizeLabel`, and all the types.
- Produces `buildReport(run: CachedRun, profile: Profile): Report`, with:

```ts
interface Quote { zh: string; en: string }
interface Flag { group: 'fit' | 'quality' | 'shop'; text: string; source: string } // source e.g. "14 reviews"
interface Report {
  summary: { sizeTile: string; reviewsLean: string | null; positivePct: number | null; sold: string | null };
  size: null | { chartFound: boolean; fit: FitResult | null; shopGuide: string | null;
    chartSays: string | null; reviewsSay: string | null; quotes: Quote[] };
  reviews: { positivePct: number | null; total: number; liked: string[]; disliked: string[]; quotes: Quote[] };
  shop: { rows: [string, string][] };
  flags: Flag[];
}
```

- Produces `shopFlags(product: ProductData): Flag[]`.

**Rules:**
- **`size` is null** when `chart.category === 'other'` and `skuSizes` has no size-like labels (spec: non-clothing skips the size section).
- **`positivePct`:** round(100 · pos / (pos + neg + mixed)); null if there are no labels. `total` is the number of reviews.
- **Sizing consensus.** Let `n` be the number of labels with non-null `sizing`, and `small` and `large` the counts of each.
  - `reviewsSay`: `"{small} of {n} sizing comments say it runs small"` when small ≥ large and small > 0, the mirror wording for large, or `"{tts} of {n} say true to size"`.
  - **Lean:** when `small/n ≥ 0.3` and `small > large`, lean one size up from the recommended size in chart row order; mirror for large. If there's no recommended size, or it's already the end row, lean is `null`.
  - `summary.reviewsLean` is shown only if it differs from the recommended size (spec §7). Its format is `"XXL?"`.
- **`chartSays`:** `"Chart says {rec}"` with a short reason from the recommended `SizeFit.note`. When there's no chart: null.
- **No chart (spec §7):**
  - `fit = null`
  - `shopGuide = pickFromHwTable(...)` formatted `"Shop's guide says L"`
  - `sizeTile` is `"Shop guide: L"`, or `"No chart"`
  - `reviewsSay` also includes nearby reviewers when available: `"People your height/weight bought XL (5), L (2)"`
- **With a chart:** `sizeTile` = recommended label, or `"—"`.
- **Quotes:** sizing quotes are up to 3 translated indices whose label has non-null sizing, preferring ones with height/weight. Review quotes are up to 4 other translated indices. `zh = reviews[idx].text` (trimmed to 140 chars with "…").
- **Review flags:** `source = "{reviewIdx.length} reviews"`.
- **Shop rules (`shopFlags`):**
  - any DSR < 4.6 → `"Low {name} rating ({v})"`
  - `ageYears < 1` → `"Shop opened {n} months ago"` (rounded months)
  - `salesCount < 100` → `"Few sales ({n})"`
  - all with source `"shop page"`
- **Sort flags:** fit, quality, then shop.
- **`shop.rows`:** Sold, Description match, Service, Shipping, Shop age, plus `product.shop.extra` entries. Omit missing values.

- [ ] **Step 1: Write the failing tests** using a hand-built `CachedRun`:
  - chart L/XL/XXL, profile → rec XL
  - labels: 4 runs_small and 6 true_to_size → n = 10, small/n = 0.4 → lean XXL
  - expected: `summary.reviewsLean === 'XXL?'`, `size.reviewsSay === '4 of 10 sizing comments say it runs small'`

  Also:
  - Equal small/large (or below 0.3) → lean null.
  - No chart with an hw table → `sizeTile 'Shop guide: L'`, `fit null`.
  - No chart, no hw → `'No chart'`.
  - Category `other` with skuSizes `['黑色','白色']` → `size === null`.
  - A quote's `zh` equals the stored review text exactly.
  - `shopFlags` with DSR 4.5 and age 0.4 years gives two flags, the second reading `'Shop opened 5 months ago'`.
  - Flags sort fit → quality → shop.
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `build.ts` and `shopFlags.ts`.**
- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(report): assemble report view-model and shop-trust flags`.

---

### Task 13: Side panel UI, states and orchestration

**Files:**
- Create: `src/panel/panel.html`, `src/panel/panel.ts`, `src/panel/panel.css`, `src/panel/render.ts`
- Test: `tests/panel/render.test.ts`, `tests/panel/panel.test.ts` (jsdom; chrome APIs and the AI modules mocked)

**Interfaces:**
- Consumes: `buildReport`, `readSizeChart`, `analyzeReviews`, storage functions, and the port protocol (Task 8).
- Produces `renderReport(root: HTMLElement, r: Report): void` and `renderState(root: HTMLElement, s: PanelState): void`.

  `PanelState` is one of:
  - `{ kind: 'not_taobao' }`
  - `{ kind: 'no_settings' }`
  - `{ kind: 'idle'; cachedAt?: number }`
  - `{ kind: 'progress'; msg: string }`
  - `{ kind: 'captcha' }`
  - `{ kind: 'error'; msg: string }`

**Layout** (approved mockup `panel-layout-v2.html`):
- A sticky header with "Taobao Shopper", the profile hint (e.g. "Profile: tops = oversized"), and a tab bar **Size · Reviews · Shop · Flags (n)**. The tabs are `<a>` elements that `scrollIntoView({behavior:'smooth'})` to the sections and never hide anything. Flags gets a red border when n > 0.
- **Summary row:** four tiles (sizeTile, reviewsLean if any, positive %, sold).
- **Size section:** table (Size + one column per measure present + "Fit for you"), with the recommended row bold and ★. Below it:
  - the comparedAgainst line
  - the fit detail lines
  - a two-box "Chart says" / "Reviews say" row (or the "No size chart found in the photos" notice + "Shop's guide says")
  - quotes (Chinese line above, English line below)
- **Reviews section:** positive % bar, Liked/Disliked, quotes.
- **Shop section:** key/value grid.
- **Red flags section:** each flag shows its group label (Fit / Quality / Shop trust) and its source.
- **Footer:** "Re-analyse" button and "Analysed {time ago}".
- The Size section and tab are omitted when `report.size === null`.
- All text goes in through `textContent`, never `innerHTML` with data (this is scraped content).

**State copy:**
- `not_taobao`: "Open a Taobao product page (item.taobao.com) to analyse it."
- `no_settings`: "Add your Anthropic API key in Settings first." with a button that calls `chrome.runtime.openOptionsPage()`.
- `idle`: button "Analyse this product".
- `captcha`: "Taobao is asking for a verification. Solve it in the page, then click Continue." with buttons **Continue** (→ `resume`) and **Use what you have** (→ `finish`).
- `error`: the message + **Retry**.

**Orchestration (`panel.ts`):**
1. On load and on `chrome.tabs.onActivated`/`onUpdated`: read the active tab URL. If it isn't `item.taobao.com/item.htm`, show `not_taobao`. Get `itemId` from the `id` query param.
2. If there are no settings, show `no_settings`. If the cache has the item, render `buildReport(cached, await loadProfile())` immediately; otherwise show `idle`.
3. On Analyse or Re-analyse:
   - connect the port to the tab's content script and send `collect`
   - progress shows "Reading reviews ({n} so far)…"
   - captcha → captcha state
   - on `done`, run `readSizeChart` (progress "Reading size chart…") and `analyzeReviews` (progress "Analysing reviews…") in parallel
   - store a `CachedRun`, then render
   - if `done` arrives with 0 reviews, still render, with the Reviews section reading "No reviews found on this page."
4. Errors from any step go to the `error` state with that step's plain-English message. If the content script connection fails, use "Reload the Taobao tab and try again."
5. Re-render from the cache when the profile changes (`chrome.storage.onChanged` on `profile`). This needs no API call.

- [ ] **Step 1: Write the failing tests.**
  - `renderReport` with the Task 12 test report:
    - has 4 tab links
    - the table has a `tr` containing "★" and "XL"
    - "Flags (2)" text
    - no `<script>` is created when a review text contains `<img src=x onerror=alert(1)>` (render it and assert the text appears literally)
  - Same with `size: null`: no Size tab or section.
  - `renderState` for each state shows the exact copy above.
  - In `panel.test.ts`:
    - a URL of `https://www.baidu.com` shows `not_taobao`
    - a mocked port emitting `captcha` and then (after Continue) `done` calls `resume` once and finally renders a report
    - `readSizeChart` rejecting with "Your Anthropic API key was rejected. Check it in Settings." shows that message and a Retry button
    - `done` with zero reviews renders "No reviews found on this page."
- [ ] **Step 2: Run the tests to confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `render.ts`, `panel.ts`, `panel.html` and `panel.css`.** Style follows the mockup; respect `prefers-color-scheme`.
- [ ] **Step 4: Run the tests to confirm they pass, then build.** Run `npm run build && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(panel): report rendering, states, and orchestration`.

---

### Task 14: End-to-end check on real pages (with the user)

**Files:** none new; fixes go into the owning files.

- [ ] **Step 1: Run on the four fixture products.** With the real profile and key, run the extension on each of the four product types from Task 2, plus one new clothing item not seen before. For each, record: chart found (y/n), recommended size, whether it matches what the user would pick, the number of reviews collected, whether a captcha appeared, the cost from the Anthropic console, and the time to result.
- [ ] **Step 2: Check the acceptance criteria:**
  - every quote's Chinese text appears on the page
  - no measurement appears that isn't in the chart
  - a no-chart item shows "No size chart found in the photos" and no ★
  - a non-clothing item has no Size section
  - each check costs under US$0.20
  - review collection takes under 3 minutes
- [ ] **Step 3: Fix any failures.** Add a regression test in the owning task's test file for each one, and re-run `npm run build && npm test`.
- [ ] **Step 4: Commit** with message `fix: end-to-end adjustments from real-page testing`.
