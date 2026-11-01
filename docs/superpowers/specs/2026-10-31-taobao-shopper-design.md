# Taobao Shopper — Design

**Date:** 2026-10-31
**Status:** Approved 2026-10-31

## 1. Intent

Buying clothes on Taobao means squinting at Chinese size charts buried in product photos, guessing how a garment's measurements translate to your body, and skimming hundreds of Chinese reviews to find out whether it runs small or falls apart. This tool does that reading for one person (the user) and answers: **which size should I buy, how will it fit me, do people like it, and what should worry me?**

Success: on a product page the user can open the panel, wait briefly, and make a confident buy / size / skip decision without reading any Chinese themselves.

## 2. What it is

A **Chrome extension** (Manifest V3) with a **side panel**. The user browses Chinese Taobao normally while logged in, opens a product page, clicks the extension, and the side panel shows an English report about that product.

- Single user, single profile.
- Uses the **user's own Anthropic API key**, pasted once into the extension's settings and stored locally.
- Covers **all categories**: tops, bottoms, shoes, and everything else. For items with no sizes (bags, accessories, gadgets), the size section is skipped and the report covers reviews, shop, and red flags only.

## 3. Goals

1. **Read the size chart**, which is usually an image inside the product photos or detail images, in Chinese. Extract it into a table of sizes × measurements in cm.
2. **Recommend one size** for the user and explain how it fits, measurement by measurement (e.g. "chest 14 cm looser than your body, length about the same as your favourite hoodie, sleeves 2 cm short"). Also say how the neighbouring sizes would fit (tighter/looser, shorter/longer).
3. **Summarise reviews**: overall sentiment, % positive, what people like, what they dislike, and what they say about sizing.
4. **Red flags**, in three groups:
   - **Fit complaints**: runs small or large, shrinks, doesn't match the chart.
   - **Quality issues**: thin fabric, pilling, smell, fading, loose threads, colour not matching the photos.
   - **Shop trust**: low shop ratings, a new shop, low sales, suspicious review patterns (e.g. many near-identical short reviews, cashback-for-good-review mentions such as 好评返现).
5. **Sales and shop stats**: units sold, the shop's DSR ratings (description / service / shipping), shop age, and any other trust indicators shown on the page.
6. **When chart and reviews disagree, show both and let the user decide.** The tool never silently overrides one with the other. Example: "Chart says XL. Reviews lean XXL: 31 of 120 sizing comments say it runs small."
7. **Price in Canadian dollars** (added 2026-10-31): show the item price in CNY and CAD (range when variants differ, plus the coupon price when shown). Item price only; shipping and agent fees are excluded. The rate is the ECB daily rate via a free public API, refreshed at most once a day, with a backup rate the user sets in Settings; the rate's date is shown.
8. **Per-item fit choice** (added 2026-10-31): each item is first matched to the user's usual fit for its category. Buttons on the item (Fitted · True to size · Relaxed · Oversized) let the user choose a different fit for that item only. The recommendation, ★ and fit notes recompute instantly without new API calls, and the choice is remembered for that item, with "Reset to my fit".

## 4. Non-goals

- Listing tricks: misleading "from" prices that only cover one variant, stolen model photos, a chart that contradicts photos. The user explicitly did not choose this group.
- Multiple user profiles.
- Tmall HK, overseas/English-only Taobao, and other platforms (e.g. 1688, Pinduoduo, JD). Tmall (`detail.tmall.com`) was added to scope on 2026-11-01.
- Buying, adding to cart, price tracking, price comparison across shops.
- Working without the user being logged into Taobao in that browser.
- Mobile.

## 5. Anti-goals (failure even if it "works")

- **Confidently wrong sizes.** If the size chart can't be found or read, say so plainly ("No size chart found in the photos") and fall back to the shop's height/weight guidance and reviewers' body stats. Never invent measurements.
- **Hiding disagreement.** Chart vs reviews conflicts must be visible at the top.
- **Losing the source.** Every review claim shown in the report must be backed by real quotes, in the original Chinese with an English translation, so the user can trust it.
- **Surprise costs.** No background calls; the analysis runs only when the user asks for it. Image and review counts per check are capped.

## 6. User profile (settings page)

All measurements in **cm** (weight in **kg**). Every field is optional; the tool uses whatever is filled in.

**Body measurements:** height, weight, chest, waist, hips, shoulder width, sleeve/arm length, inseam, thigh, foot length (and usual EU/CN shoe size).

**Reference garments (flat-lay measurements of clothes that fit well):** at least one slot each for:
- **Top**: chest (pit-to-pit ×2, i.e. full circumference as Taobao charts list it), length, shoulder, sleeve.
- **Bottoms**: waist, hips, length, inseam, thigh, leg opening.
- **Shoe**: brand + size that fits, optionally insole length.

Each reference garment has a free-text label (e.g. "Uniqlo hoodie L") and **a fit tag for each measurement entered**, describing how that measurement fits the user:
- Width-type measurements (chest, waist, hips, thigh, shoulder): tight / fitted / just right / relaxed / oversized.
- Length-type measurements (length, sleeve, inseam): too short / slightly short / just right / slightly long / too long.

These tags are structured choices, not free text, so the fit code can use them directly. An optional free-text note is allowed for the user's own reference only; the tool doesn't interpret it.

**Fit preference per category:** for tops, outerwear, bottoms, and shoes, choose one of: fitted / true to size / slightly relaxed / oversized.

**How the profile drives sizing (decided with the user):**
1. Body measurement + reference garment measurement + fit tag together calibrate *the user's personal ease scale*. Example: hoodie chest 120 − body chest 108 = +12 cm, tagged "relaxed", so for this user about +12 cm in the chest = relaxed.
2. The category's fit preference sets the target feel. If it matches the garment's tag, the target is the garment's ease. If it's looser or tighter (e.g. preference "oversized", garment "relaxed"), the target shifts from the calibrated point by a standard step per fit level (step sizes left to the builder).
3. For length-type measurements, the tag corrects the target directly. "Slightly long" sleeves at 62 cm means the target is a bit shorter than 62.
4. Each size's fit note is phrased against the garment the user knows, e.g. "chest 2 cm roomier than your hoodie (relaxed → a bit oversized), sleeves same as your hoodie (which you find slightly long)".
5. Fallbacks, in order: no garment for the category → body measurements + standard ease for the fit preference. No body measurements either → height/weight against the shop's height/weight table and reviewers' stated stats.

**API settings:** Anthropic API key and model choice (sensible default preselected).

**Currency:** optional backup exchange rate (1 CNY in CAD), used only when today's rate can't be fetched.

The settings page shows short hints on how to measure each field. Taobao charts list **garment** measurements, not body measurements, and the hints should say this.

## 7. The report (side panel)

Approved layout ("B revised"; mockup at `.superpowers/brainstorm/473-1793472530/content/panel-layout-v2.html`):

- **Everything on one scrolling page, nothing collapsed.** The user wants to see it all at once with minimal clicking.
- **A tab bar is pinned at the top: Size · Reviews · Shop · Flags (n).** Tabs are jump links that scroll to the section; they never hide other sections. The Flags tab shows the count and is highlighted when there are flags.
- **Summary row at the top:** chart's size pick · size reviews lean towards (only if different) · % positive · units sold.
- **Price line** above the summary row: "¥129–159 ≈ CA$25.09–30.93", plus the coupon price and the rate's source/date.
- **Size section:**
  - A fit selector (Fitted · True to size · Relaxed · Oversized), with the user's usual fit marked "your fit" and preselected for every new item.
  - A table: one row per size; columns for each measurement the chart provides; a final "Fit for you" column with a short note such as "Regular, sleeves −2" or "Very baggy". The recommended row is highlighted with ★.
  - A line saying what it compared against (e.g. "vs your body (chest 108) and fav hoodie (chest 120, length 71)").
  - "**Chart says**" and "**Reviews say**" side by side.
  - Two or three sizing quotes from reviews, Chinese plus English, ideally including reviewers' height/weight + size bought (e.g. "175/70 买的XL 刚好宽松").
- **Reviews section:** % positive with a bar, liked / disliked bullets, two to four representative quotes (Chinese + English).
- **Shop section:** sales, DSR scores, shop age, other indicators found on the page.
- **Red flags section:** each flag tagged with its group (Fit / Quality / Shop trust) and backed by a count or source ("14 reviews mention pilling").
- **No size chart found:** the size table is replaced by a plain notice ("No size chart found in the photos"). If the shop's height/weight table exists, its pick for the user's height/weight is shown labelled "Shop's guide says". The reviewers' sizing consensus is shown as "Reviews say". Without a chart, the summary row's size tile shows "Shop guide: L" or "No chart" rather than a chart pick. No ★ is shown unless a size was computed from measurements.
- **Status states:**
  - idle ("Analyse this product" button)
  - progress messages while working ("Reading size chart… Reading reviews (32 so far)…")
  - **captcha paused:** "Taobao is asking for a verification. Solve it in the page, then click Continue." Continue resumes collection; "Use what you have" finishes with the reviews collected so far.
  - error states with a plain-English cause and a retry button

## 8. How it works (high level)

1. **Collect** (content script on Chinese Taobao product pages, `item.taobao.com`):
   - Product title, price, SKU options (sizes/colours), sales count, shop name + DSR scores + shop age, shop's own size guidance text if any.
   - Image URLs: main gallery, SKU images, and the long detail images (详情), which load lazily. The size chart is usually in the detail images.
   - Reviews: open the reviews view and scroll/paginate to collect **about 40–80** review texts, including the SKU purchased (size/colour) and any body stats mentioned. Prefer reviews that mention sizing (尺码, 偏大, 偏小, 身高, 体重…). **Collection is careful (decided with the user):** human-paced scrolling with randomised delays, no rapid pagination. If Taobao shows a slider captcha or verification, stop immediately and show the "captcha paused" state. Never try to solve or bypass it.
2. **Read the size chart.** First use the structured per-size measurements many listings embed in their data, which costs nothing (added 2026-11-01). Only when those are absent, read the chart with Claude vision: find the chart among the images and extract a structured table (size → measurement name → cm), plus any height/weight recommendation table. Return "not found" when appropriate, never guesses.
3. **Compute fit** in plain code (deterministic, not by the model), using the calibration method in §6: per-measurement target from body + calibrated ease + fit preference; score each size by distance from the targets; pick the best; produce per-measurement deltas and the "Fit for you" note phrased against the reference garment. The height/weight fallback is also code: a lookup against the shop's height/weight table. The model only *extracts* reviewers' stats and sizing claims; it never picks the size.
4. **Analyse reviews** with Claude: sentiment, likes/dislikes, sizing consensus ("runs small" count), red flags with counts, and verbatim Chinese quotes with translations.
5. **Render** the report in the side panel.

## 9. Constraints

- **Taobao and Tmall** (`item.taobao.com` and `detail.tmall.com`, prices in CNY). Tmall was added on 2026-11-01. The user's site may display in English: the browser translates the page, but the underlying data stays Chinese, so the tool reads the data rather than the displayed text.
- **Account safety comes before completeness.** Fewer reviews is acceptable; tripping Taobao's anti-bot measures is not.
- **Logged-in browser only.** Taobao hides reviews and much detail when logged out and blocks scrapers. Collection happens in the user's real tab; no headless scraping or external servers.
- **Taobao's page structure changes often.** DOM selectors should be isolated in one module so they're easy to fix, and the collector should degrade gracefully when a field is missing (report "not found" rather than fail entirely).
- **Direct browser calls to the Anthropic API** (no backend). The API key never leaves the user's machine except in calls to Anthropic.
- **Cost:** a typical check should cost cents, not dollars. Cap images sent (most likely only the images relevant to sizing) and review count.
- **Project rules (CLAUDE.md):** source in `/src`, tests in `/tests`; files under 500 lines; validate input at boundaries (profile inputs, model outputs); no secrets committed.

## 10. Decisions made, and by whom

**The user decided:**
- Chrome extension with side panel; their own Anthropic API key.
- All categories; non-clothing items get reviews/shop/flags only.
- All three measurement kinds: body, reference garments, height/weight.
- Fit preference set per category.
- Red flag groups: fit, quality, shop trust (not listing tricks).
- Report in English with key quotes shown in Chinese + English.
- Single user.
- Chart vs reviews conflict: show both; the user decides.
- Layout: B revised (all on one page, pinned jump-link tabs, summary row).
- Chinese Taobao only.
- Careful review collection (~40–80 reviews, human pace, pause on captcha).
- Sizing model: body + reference garment + per-measurement fit tags calibrate personal ease; category preference sets the target (§6).
- Prices also in CAD; per-item fit selector that starts at the usual fit (added 2026-10-31).

**My calls (the user can override):**
- No-chart behaviour (§7): show "No size chart found", the shop's height/weight guide pick, and the reviews' consensus; no ★.
- Test fixtures: the plan starts with capturing real logged-in product pages (clothing with a chart in the detail images, clothing without a chart, shoes, a non-clothing item). These are captured from the user's browser, with the user's help if needed, and saved as fixtures before the page-reading code is written.
- Fit math is done in deterministic code; the model only reads the chart and the reviews.
- Analysis runs only on click, and the result is cached per product ID so reopening the panel doesn't cost again (with a "re-analyse" button).
- Exchange rate: ECB daily rate via api.frankfurter.app, cached 24 h, backup rate in Settings; item price only.
- The per-item fit choice is remembered for that item.
- Default model: a current Claude model with vision. Use the latest Sonnet-class model as the default for chart reading and review analysis; it's selectable in settings.

## 11. Left to the builder

- Tech stack and build tooling for the extension (language, bundler, UI framework or none), and test framework.
- Exact DOM selectors / data sources for Taobao product pages (DOM vs intercepting the page's own data responses), and how to drive review loading.
- Image selection heuristics (which images are likely to contain the size chart) and the image cap.
- Ease allowances per fit preference and per measurement, and the fit-note wording thresholds (e.g. what counts as "slightly loose" vs "baggy").
- Prompt design, structured output schemas, and validation of model output.
- Shoe sizing conversion approach (foot length ↔ CN/EU sizes).
- Visual styling of the panel beyond the approved layout.
