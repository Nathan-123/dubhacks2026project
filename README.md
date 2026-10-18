# FitCheck

**The one job:** answer "what size do I buy here?" on any store, and get better at it over time.

FitCheck is a Chrome extension (MV3) with a small local backend. It gives a useful verdict on the first product page with zero setup (rung 0), gets personal after one 5‑second tap (rung 1), calibrates per brand from your orders (rung 2), and learns from "did it fit?" feedback (rung 3). "FitCheck" is a working name — product name is still an open decision; change `PRODUCT_NAME` in [extension/content/badge.js](extension/content/badge.js) and the manifest.

---

## Quick start (everything runs locally)

```bash
npm install
node server/index.js          # backend on http://localhost:8787
npm test                     # extractor, scorer, content races, server, mocked LLM + OpenRouter
npm run check                # JS syntax, architecture source guards, generated probe consistency
```

**Completely free.** The AI parts use free models only:

1. **OpenRouter (confidence scores + page reader).** Create a key at https://openrouter.ai/keys, then `copy .env.example .env` and set `OPENROUTER_API_KEY=...`. The server reads `.env` on startup. Before calling any model it checks OpenRouter's price list and **refuses any model that isn't $0**. The default `openrouter/free` routes to whichever free model is available. Free models are rate-limited, so results are cached.
2. **Ollama (optional, fully local page reader).** `winget install Ollama.Ollama`, `ollama pull qwen2.5:3b`, then set `FIT_LLM_PROVIDER=ollama`. Nothing leaves the laptop.

Without either, everything still works: confidence falls back to the rule-based number, and pages the on-device tiers can't read show *Can't read this page*. The server prints which pieces are on when it starts.

**Load the extension:** `chrome://extensions` → Developer mode → *Load unpacked* → pick `extension/`.

1. Open a product page on a store → click the FitCheck toolbar icon → **Enable on this store** (Chrome's own one-site prompt) or **Just check this page**.
2. The badge appears next to the store's size buttons. Click it for the card; tap your usual size to personalize.
3. **Open wardrobe** (from the card or the popup) → **Load demo data** to seed the demo profile ([extension/wardrobe/seed.json](extension/wardrobe/seed.json)).
4. All badge states, no store needed: `chrome-extension://<id>/demo/states.html`.

## Before anything else: run the probe

Every coverage number in the product doc is a hypothesis until this replaces it.

```bash
node scripts/build-probe.js   # regenerates probe/fit-probe.js from the real extractor
```

Paste [probe/fit-probe.js](probe/fit-probe.js) into the DevTools console on a product page. It reports which tiers hit, which contract fields each one filled, what the rung‑0 badge would say, and raw signals (JSON‑LD types, Shopify, `__NEXT_DATA__`, review platform, fit text, chart tables/images/modals). The report JSON is copied to your clipboard — save it as `probe/results/<store>.json`. Run it on ten pages to pick the demo stores. The probe is built from the same `extract.js` the extension runs, so what it measures is what the product will get.

---

## Architecture

Four main modules, each with a one-line contract. Store-specific knowledge stops at `extract`.

| Module | Contract | File | Hides |
|---|---|---|---|
| extract | `(document) → Product \| explicit failure` | [extension/lib/extract.js](extension/lib/extract.js) | which tier produced the data, per-store quirks |
| score | `(Product, Profile) → Recommendation` | [extension/lib/score.js](extension/lib/score.js) | signal weights, confidence |
| profile | `(event) → Profile` | [extension/lib/profile.js](extension/lib/profile.js) | how baselines are learned and stored |
| badge | `(Recommendation) → UI` | [extension/content/badge.js](extension/content/badge.js) | docking, shadow-DOM CSS isolation |

Glue: [content/content.js](extension/content/content.js) (wires the four on a page, size-click re-score, SPA navigation, order capture), [background.js](extension/background.js) (permissions → dynamic content scripts, store configs, local product cache, all backend calls), [wardrobe/](extension/wardrobe/), [popup/](extension/popup/).

`lib/*.js` are UMD: the same files load as content scripts, in the service worker, and via `require()` in the server and tests. `score` has no DOM and no network.

[classification.js](extension/lib/classification.js) owns shared clothing category and section rules, without DOM or network dependencies. Both extraction and order normalization use it; orders do not depend on the page reader. `extract.findReviewRegion()` returns the review element (or null); extractor `_internal` is diagnostic-only, for tests and the probe. The content controller snapshots scoring inputs and only publishes results from the latest still-current operation.

### The data contract

[extension/lib/contract.js](extension/lib/contract.js). One normalized `Product` shape, every field nullable except the floor (brand, name, size options). Extractors write only through `contract.fill()`, which never overwrites a field a stronger tier already set and records the tier in `_src`. Tests assert that every filled field has provenance and that an empty extraction is an explicit failure.

### Extraction tiers (cheapest first, gaps only)

| Tier | Source | Where |
|---|---|---|
| 0 | Shopify `/products/<handle>.js` (incl. chart in `body_html`) | content script |
| 1 | JSON-LD `Product` / `ProductGroup` | content script |
| 2 | `__NEXT_DATA__`, `application/json` scripts, `digitalData`/`__NUXT__` when plain JSON | content script |
| 3 | Review widgets (Okendo, Yotpo, Judge.me, Bazaarvoice, PowerReviews, Stamped, Loox, generic): fit distribution, fit meter, per-review verdict/size/height — never review text | content script |
| 4 | DOM: size control (select / radios / buttons near "size"), chart `<table>` (garment vs body vs unknown), fabric, model reference, cut words, section from URL/breadcrumbs | content script |
| 5 | Free LLM (OpenRouter free models, or local Ollama) over trimmed page text, schema-constrained JSON, with a hallucination guard: sizes, chart values, fabric and fit stats are kept only if they appear in the page text | `POST /extract-product` |
| 6 | Vision for image-only charts | **not built** (stretch; a free local vision model like `llama3.2-vision` could slot in) — `imageOnly: true` lowers confidence instead |

Store configs are data: [extension/stores.json](extension/stores.json) presets + per-store edits in the wardrobe tab (anchor selector, size-control selector, review container, lazy reviews, section). An unknown store runs the same pipeline with an empty config and a floating badge. **The preset selectors are placeholders until the probe runs.**

### Scoring

`recommended = baseline − offset_item + adjust_preference`, all in size steps on the garment's own ladder. All tunable numbers are in `CONFIG` at the top of [score.js](extension/lib/score.js).

- **Offset** blends review aggregate/distribution, reviewer verdicts, cut language (not for waist-sized bottoms) and an optional brand prior, strongest-first; weak evidence is shrunk toward zero.
- **Baseline**, in priority: fit feedback on this brand → this brand's wardrobe items → stated size (overridden by the wardrobe only when **2+ items agree** — the proposed conflict rule, implemented) → nearest category (borrowed, lower confidence). Per section and category; recent feedback weighs more (180-day half-life); contradictory feedback on a brand is surfaced, not averaged away.
- **Fit score and confidence are separate, and the UI keeps them from contradicting each other.** Fit (0–100, always shown with words: Great / Good / Risky / Poor) is how well a size matches you. Confidence (Low / Medium / High, with a "based on" list) is how much data backs it. When confidence is low there is no fit number at all, only *Best guess · M*: without item data the fit score just measures distance from your usual size, so showing "97/100" would claim a precision we don't have. Sizes at the ends of a range with thin review evidence lose confidence (fairness rule).
- **The badge judges the size you picked.** If your selection is meaningfully worse than the best size in stock, the badge says *Size up/down → X*, even when X itself is only a risky fit.
- **Confidence model (OpenRouter).** [server/confidence.js](server/confidence.js) asks a free model to rate confidence from an evidence summary built by the scorer: which kinds of data exist and how much, never sizes, brands or wardrobe contents. The fit score stays rule-based. The extension waits up to 3s for the model, then uses the rule-based number, so a verdict is never shown and then flipped. The card marks model-rated confidence *AI-assessed*, and *How we got this* shows both numbers. This is the seam for the team's own model: set `CONFIDENCE_MODEL` (any free OpenRouter model) or replace `estimate()`. Toggle: Wardrobe → Stores → Advanced.
- Out-of-stock best size → next best available, said plainly. One-size → no size recommendation. Children's/maternity and listing pages → silent.

### Backend ([server/](server/))

Stateless, holds no user data, costs nothing to run.

| Endpoint | In | Out |
|---|---|---|
| `POST /extract-product` | url, trimmed text, JSON-LD, partial Product | Product: cache first, else the local LLM fills the gaps (cached per canonical URL in `server/cache/`) |
| `POST /score-fit` | product, profile | recommendation + `best_size`, `scores_by_size`, `confidence`, `reason`, `alert` |
| `POST /parse-order` | scrubbed line items only | wardrobe items (heuristics; local LLM labels brand/category when running) |
| `POST /confidence` | evidence summary (no sizes/brands) | `{ confidence, reason, model }` from a free OpenRouter model |
| `GET /health` | | page-reader and confidence-model status, cache size |

The page reader ([server/llm.js](server/llm.js)) uses OpenRouter when a key is set, otherwise Ollama (`FIT_LLM_PROVIDER` forces one). Both run at `temperature 0` with JSON-schema output; [server/openrouter.js](server/openrouter.js) is the only OpenRouter-specific file, with plain `fetch` and no SDK. Settings live in [.env.example](.env.example). Results are cached so each page is read once.

Scoring runs on-device by default (under 1 ms). Wardrobe → Stores → Advanced → "Score on the backend" routes it through `/score-fit` for live tuning without reloading the extension.

---

## Compliance model, as built

- Runs only on stores the user enabled via `chrome.permissions.request()` per origin (`optional_host_permissions`; no all-sites warning at install), or once on the current tab via `activeTab`.
- Only same-origin sub-requests the page itself makes (Shopify `.js`). No background crawling.
- Order pages are reduced to `{name, size, price}` line items in the content script; anything that looks like an email, phone, card or street address is dropped before it leaves the page, and again on the server.
- Computed facts only ("62% said runs small"); review text is never stored. A test asserts this.
- Delete everything (wardrobe tab) clears storage, the cache, and revokes store permissions; open product tabs revert to rung 0 immediately.

## Testing

`npm test` includes permanent regressions for navigation/profile/size scoring races, grounded model facts, malformed confidence and uncached retries. `npm run check` checks JavaScript syntax in the project source directories, direct diagnostic accesses in production, classification dependencies, and probe consistency. These are lightweight source guards, not a linter, formatter or typechecker. Run `npm run build:probe` after changing bundled modules. Live-store and manual Chrome QA remain separate.

[fixtures/manifest.json](fixtures/manifest.json) lists cases: page HTML + capture URL + optional Shopify stub + expected extraction (subset match). Run one without a browser:

```bash
node scripts/extract-fixture.js --case shopify-tee --score
node scripts/extract-fixture.js path/to/saved.html https://store.com/products/x
```

**All current fixtures are synthetic.** Save real demo pages as `fixtures/pages/<store>-<product>.html`, add a case, and write the expected JSON from what you verified on the live page.

## Demo script → what drives each beat

| Beat | Driven by |
|---|---|
| Uniqlo jeans — *Good buy · 29* | stated `men:bottom = 29` in the seed + true-to-size signal |
| Click wrong size — *Size up*, both scores | live size-control watcher → re-score → `sizeChange` |
| A&F jacket — *Likely return* + "you own 2 like this" | seed: A&F XL rated *too small* → baseline past the largest size; two jackets → duplicate alert |
| Add a Shopify brand live | popup **Enable on this store** or wardrobe **Add store** → one permission prompt → empty config, same pipeline |
| Three-tap feedback, confidence jumps | rate the Uniqlo jeans *Fit well* → baseline source becomes brand feedback (+16 confidence, Medium → High); open tabs re-score live |
| Privacy panel | wardrobe tab |

Pre-cache: visit each demo page once before presenting. The extension caches every successful Product per canonical URL and serves it (badge shown dashed, "cached") if live extraction fails or the backend is down.

## Known gaps

- Not yet run against live stores — the probe exists for exactly this. Selectors, review-widget patterns (especially Okendo's fit attributes) and the state-blob walker are unverified on real pages.
- Size-chart modals are not opened (we fall through rather than risk stealing focus). Vision tier not built.
- The LLM and confidence paths are tested against mocked OpenRouter/Ollama servers, not yet against real models; small models can miss fields, which the hallucination guard drops rather than guesses.
- Lazy-loaded reviews are only scrolled into view when a store config sets `lazyReviews: true` (it moves the page briefly; scroll position is restored).
- No cross-system size conversion (by design for v1). Order-history import, Fit Passport, pairing alerts: not built (stretch / cut list).
- Size-click detection on unknown stores re-reads the detected control after any click; stores with fully custom pickers may need a `sizeControl` selector in their config.
