# FittingRoom

**The one job:** answer "what size do I buy here?" on any store, and get better at it the more you shop.

FittingRoom is a Chrome extension (MV3) with a small local backend. It starts with a four-question setup (section, height, how you like things to fit, and one piece that fits you well). On a product page it shows a size verdict next to the store's size buttons, personalized by what you told it. It learns from the sizes you own and from "did it fit?" feedback, and it knows each store's return window so it can tell you how long you have to send something back.

FittingRoom is a hackathon build. Your data stays in the browser. The optional backend runs on your own computer.

> **Naming:** the product is **FittingRoom**. Some UI strings and the manifest name still say "Fitting Room" and are being renamed.

---

## Quick start (everything runs locally)

```bash
npm install
npm start                     # backend on http://localhost:8787
npm test                      # node --test test/*.test.js (121 tests)
```

**Completely free.** The AI parts use free models only.

1. **OpenRouter (confidence scores and the page reader).** Create a key at https://openrouter.ai/keys, copy `.env.example` to `.env`, and set `OPENROUTER_API_KEY=...`. The server reads `.env` on startup. Before calling any model it checks OpenRouter's price list and **refuses any model that isn't $0**. The default `openrouter/free` routes to whichever free model is available. Free models are rate-limited, so results are cached.
2. **Ollama (optional, fully local page reader).** `winget install Ollama.Ollama`, `ollama pull qwen2.5:3b`, then set `FIT_LLM_PROVIDER=ollama`. Nothing leaves the laptop.

Without either, everything still works. Confidence falls back to the rule-based number, and pages the on-device tiers can't read show *Can't read this page*. The server prints which pieces are on when it starts.

**Load the extension:** `chrome://extensions` → Developer mode → *Load unpacked* → pick `extension/`. On install, the setup page opens once.

### Using it

1. **Setup** (opens on first install): tell FittingRoom your section (men's, women's, or both), height, fit preference (Slim / Regular / Relaxed / Oversized), and one piece you own that fits well with its brand, kind, and size. Each answer is saved once and used on every store.
2. **Turn it on per store.** Open a product page → click the FittingRoom toolbar icon → **Enable on this store** (Chrome's own one-site prompt) or **Just check this page**. Nothing runs on a store you haven't enabled.
3. **Read the badge.** It appears next to the store's size buttons. If it doesn't know your size for that kind of piece yet, it asks: tap your usual size, then how you like things to fit.
4. **Your closet.** Open the wardrobe tab (from the popup or the badge) to add pieces, see your sizes per brand and kind, see return countdowns, manage the stores you turned on, and read the privacy panel.
5. **Badge states without a store:** `chrome-extension://<id>/demo/states.html`.

There is no built-in demo profile. To demo the Uniqlo and A&F beats below, set up the answers and add those pieces by hand in the closet.

## Before anything else: run the probe

Every coverage number in the product doc is a hypothesis until this replaces it.

```bash
npm run build:probe           # regenerates probe/fit-probe.js from the real extractor
```

Paste [probe/fit-probe.js](probe/fit-probe.js) into the DevTools console on a product page. It reports which tiers hit, which contract fields each one filled, what the rung-0 badge would say, and the raw signals (JSON-LD types, Shopify, `__NEXT_DATA__`, review platform, fit text, chart tables, images, modals). The report JSON is copied to your clipboard. Save it as `probe/results/<store>.json`. Run it on ten pages to pick the demo stores. The probe is built from the same `extract.js` the extension runs, so it measures what the product will get.

---

## Architecture

Four modules, each with a one-line contract. Store-specific knowledge stops at `extract`.

| Module | Contract | File | Hides |
|---|---|---|---|
| extract | `(document) → Product \| explicit failure` | [extension/lib/extract.js](extension/lib/extract.js) | which tier produced the data, per-store quirks |
| score | `(Product, Profile) → Recommendation` | [extension/lib/score.js](extension/lib/score.js) | signal weights, confidence |
| profile | `(event) → Profile` | [extension/lib/profile.js](extension/lib/profile.js) | how baselines, setup answers, and the closet are stored |
| badge | `(Recommendation) → UI` | [extension/content/badge.js](extension/content/badge.js) | docking, shadow-DOM CSS isolation |

Supporting modules: [lib/sizes.js](extension/lib/sizes.js) (size labels and ladders), [lib/returns.js](extension/lib/returns.js) (reads return windows from a store's policy page), [lib/classification.js](extension/lib/classification.js) (garment category), [lib/contract.js](extension/lib/contract.js) (the Product shape).

Glue: [content/content.js](extension/content/content.js) (wires the modules on a page, size-click re-score, SPA navigation, order capture), [background.js](extension/background.js) (install setup, permissions → dynamic content scripts, store configs, local product cache, all backend calls), [onboarding/](extension/onboarding/) (first-run setup), [popup/](extension/popup/) (per-store switch and the current result), [wardrobe/](extension/wardrobe/) (closet, stores, privacy), [ui/](extension/ui/) (shared tokens, logos, dropdown, footer), [privacy/](extension/privacy/).

`lib/*.js` are UMD: the same files load as content scripts, in the service worker, and via `require()` in the server and tests. `score` has no DOM and no network.

### The data contract

[extension/lib/contract.js](extension/lib/contract.js). One normalized `Product` shape, every field nullable except the floor (brand, name, size options). Extractors write only through `contract.fill()`, which never overwrites a field a stronger tier already set and records the tier in `_src`. Tests assert that every filled field has provenance and that an empty extraction is an explicit failure.

### Extraction tiers (cheapest first, gaps only)

| Tier | Source | Where |
|---|---|---|
| 0 | Shopify `/products/<handle>.js` (incl. chart in `body_html`) | content script |
| 1 | JSON-LD `Product` / `ProductGroup` | content script |
| 2 | `__NEXT_DATA__`, `application/json` scripts, `digitalData`/`__NUXT__` when plain JSON | content script |
| 3 | Review widgets (Okendo, Yotpo, Judge.me, Bazaarvoice, PowerReviews, Stamped, Loox, generic): fit distribution, fit meter, per-review verdict/size/height. Never review text | content script |
| 4 | DOM: size control (select / radios / buttons near "size"), chart `<table>` (garment vs body vs unknown), fabric, model reference, cut words, section from URL/breadcrumbs | content script |
| 5 | Free LLM (OpenRouter free models, or local Ollama) over trimmed page text, schema-constrained JSON, with a hallucination guard: sizes, chart values, fabric and fit stats are kept only if they appear in the page text | `POST /extract-product` |
| 6 | Vision for image-only charts | **not built** (stretch). `imageOnly: true` lowers confidence instead |

Store configs are data: [extension/stores.json](extension/stores.json) presets (anchor selector, size-control selector, review container, lazy reviews, section, and each store's return window and policy link) plus per-store edits in the closet's Stores section. An unknown store runs the same pipeline with an empty config and a floating badge. **The preset selectors are placeholders until the probe runs.**

### Return windows

[lib/returns.js](extension/lib/returns.js) finds a store's own return-policy link and reads "N days from delivery / shipping / purchase" wording. Windows with unclear wording are not guessed. The backend's `POST /return-policy` asks the local or free model to confirm the window, and only keeps it when its quote is really in the policy text. A piece's countdown starts from its order date. Curated stores use the window in `stores.json`. Other stores fall back to a default window and say so.

### Setup and closet

- **Setup** ([onboarding/](extension/onboarding/)) asks four questions, one at a time: section, height (ft/in or cm), fit preference, and the best-fitting piece. The piece becomes one closet item marked "Just right", which then personalizes other brands. Setup can be edited later.
- **Closet** ([wardrobe/](extension/wardrobe/)) lists your pieces and sizes per brand and kind of piece, with return countdowns. Feedback on each piece ("Just right", "Too small", "Too big") feeds the scorer. Items can come from an order page (`POST /parse-order` labels brand and category; size and price come from the page) or be added by hand.

### Scoring

`recommended = baseline − offset_item + adjust_preference`, all in size steps on the garment's own ladder. All tunable numbers are in `CONFIG` at the top of [score.js](extension/lib/score.js).

- **Offset** blends review aggregate and distribution, reviewer verdicts, cut language (not for waist-sized bottoms), and an optional brand prior, strongest first. Weak evidence is shrunk toward zero.
- **Baseline**, in priority order: fit feedback on this brand → this brand's closet items → stated size (overridden by the closet only when **2+ items agree**) → nearest category (borrowed, lower confidence). Per section and category. Recent feedback weighs more (180-day half-life). Contradictory feedback on a brand is surfaced, not averaged away.
- **Fit score and confidence are separate, and the UI keeps them from contradicting each other.** Fit (0–100, always shown with words: Great / Good / Risky / Poor) is how well a size matches you. Confidence (Low / Medium / High, with a "based on" list) is how much data backs it. When confidence is low there is no fit number, only *Best guess · M*. Without item data the fit score would only measure distance from your usual size, so showing "97/100" would claim precision we don't have. Sizes at the ends of a range with thin review evidence lose confidence (fairness rule).
- **The badge judges the size you picked.** If your selection is meaningfully worse than the best size in stock, it says *Size up/down → X*, even when X itself is only a risky fit.
- **Confidence model (OpenRouter).** [server/confidence.js](server/confidence.js) asks a free model to rate confidence from an evidence summary built by the scorer: which kinds of data exist and how much, never sizes, brands, or closet contents. The fit score stays rule-based. The extension waits up to 3s for the model, then uses the rule-based number, so a verdict is never shown and then flipped. The card marks model-rated confidence *AI-assessed*, and *How we got this* shows both numbers. This is the seam for a team model: set `CONFIDENCE_MODEL` (any free OpenRouter model) or replace `estimate()`.
- Out-of-stock best size → next best available, said plainly. One-size → no size recommendation. Children's, maternity, and listing pages → silent.

### Backend ([server/](server/))

Stateless. It holds no user data and costs nothing to run.

| Endpoint | In | Out |
|---|---|---|
| `POST /extract-product` | url, trimmed text, JSON-LD, partial Product | Product: cache first, else the local LLM fills the gaps (cached per canonical URL in `server/cache/`) |
| `POST /score-fit` | product, profile | recommendation + `best_size`, `scores_by_size`, `confidence`, `reason`, `alert` |
| `POST /parse-order` | scrubbed line items only | closet items (heuristics; the local LLM labels brand and category when running) |
| `POST /return-policy` | policy page text | `{ ok, days, from, … }` when the window is clear, otherwise `{ ok: false }` |
| `POST /confidence` | evidence summary (no sizes or brands) | `{ confidence, reason, model }` from a free OpenRouter model |
| `GET /health` | | page-reader and confidence-model status, cache size |

The page reader ([server/llm.js](server/llm.js)) uses OpenRouter when a key is set, otherwise Ollama (`FIT_LLM_PROVIDER` forces one). Both run at `temperature 0` with JSON-schema output. [server/openrouter.js](server/openrouter.js) is the only OpenRouter-specific file, using plain `fetch` with no SDK. Settings live in [.env.example](.env.example). Results are cached so each page is read once.

Scoring runs on-device by default (under 1 ms). Closet → Stores → Advanced → "Score on the backend" routes it through `/score-fit` for live tuning without reloading the extension.

---

## Compliance model, as built

- Runs only on stores the user enabled via `chrome.permissions.request()` per origin (`optional_host_permissions`, so no all-sites warning at install), or once on the current tab via `activeTab`.
- Only same-origin sub-requests the page itself makes (Shopify `.js`). No background crawling.
- Order pages are reduced to `{name, size, price}` line items in the content script. Anything that looks like an email, phone, card, or street address is dropped before it leaves the page, and again on the server.
- Computed facts only ("62% said runs small"). Review text is never stored. A test asserts this.
- Setup answers, closet items, and the return windows you've read are kept in browser storage. Nothing is tied to your name, address, or card.
- Delete everything (closet tab) clears storage, the cache, and revokes store permissions. Open product tabs revert to rung 0 immediately.

## Testing

```bash
npm test                                          # 121 tests across extract, score, profile, returns, server, LLM, and wiring
node scripts/extract-fixture.js --case shopify-tee --score
node scripts/extract-fixture.js path/to/saved.html https://store.com/products/x
```

[fixtures/manifest.json](fixtures/manifest.json) lists cases: page HTML, capture URL, optional Shopify stub, and expected extraction (subset match). Run one without a browser.

**All current fixtures are synthetic.** Save real demo pages as `fixtures/pages/<store>-<product>.html`, add a case, and write the expected JSON from what you verified on the live page.

## Demo script → what drives each beat

| Beat | Driven by |
|---|---|
| Uniqlo jeans — *Good buy · 29* | setup answers + a closet item for Uniqlo jeans in size 29, plus a true-to-size signal |
| Click wrong size — *Size up*, both scores | live size-control watcher → re-score → `sizeChange` |
| A&F jacket — *Likely return* + "you own 2 like this" | closet: add an A&F XL jacket and mark it *Too small* → baseline past the largest size. A second jacket → duplicate alert |
| Return countdown | closet item from a curated store → days left from the store's window, linked to its policy |
| Add a store live | popup **Enable on this store**, or closet **Add store** → one permission prompt → empty config, same pipeline |
| Three-tap feedback, confidence jumps | mark the Uniqlo jeans *Just right* → baseline source becomes brand feedback. Open tabs re-score live |
| Privacy panel | closet tab |

Pre-cache: visit each demo page once before presenting. The extension caches every successful Product per canonical URL and serves it (badge shown dashed, "cached") if live extraction fails or the backend is down.

## Known gaps

- Not yet run against live stores. The probe exists for exactly this. Selectors, review-widget patterns (especially Okendo's fit attributes), and the state-blob walker are unverified on real pages.
- Return windows are read from policy wording and tested on synthetic text. Real policy pages are unverified.
- Size-chart modals are not opened (we fall through rather than risk stealing focus). Vision tier not built.
- The LLM and confidence paths are tested against mocked OpenRouter and Ollama servers, not yet against real models. Small models can miss fields, which the hallucination guard drops rather than guesses.
- Lazy-loaded reviews are only scrolled into view when a store config sets `lazyReviews: true`. That moves the page briefly, and scroll position is restored.
- No cross-system size conversion (by design for v1). Order-history import, Fit Passport, and pairing alerts are not built.
- Size-click detection on unknown stores re-reads the detected control after any click. Stores with fully custom pickers may need a `sizeControl` selector in their config.
