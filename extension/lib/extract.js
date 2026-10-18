/*
 * extract — (document) -> Product, or an explicit failure.
 *
 * The only module that knows stores exist. Tiers run cheapest first; each one only
 * fills gaps (contract.fill never overwrites). Tier 5 (a free local LLM) runs on the
 * backend; this module reports what is missing so the caller can ask for it.
 *
 * Works on a real page and under linkedom in tests. Network is injected (fetchJson)
 * so tier 0 can be stubbed with fixture JSON.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode ? { sizes: require('./sizes.js'), contract: require('./contract.js') } : root.FitKit;
  const mod = factory(deps.sizes, deps.contract);
  if (isNode) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).extract = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sizes, contract) {
  'use strict';

  const { fill } = contract;

  // ---------------------------------------------------------------------------
  // small DOM helpers

  function txt(el) {
    if (!el) return '';
    const t = el.innerText != null && el.innerText !== '' ? el.innerText : el.textContent;
    return String(t || '').replace(/\s+/g, ' ').trim();
  }
  const $ = (root, sel) => { try { return root.querySelector(sel); } catch (_) { return null; } };
  const $$ = (root, sel) => { try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return []; } };
  const meta = (doc, name) => {
    const el = $(doc, `meta[property="${name}"]`) || $(doc, `meta[name="${name}"]`);
    return el ? (el.getAttribute('content') || '').trim() || null : null;
  };
  const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null);

  function cssPath(el) {
    if (!el || !el.tagName) return null;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.tagName && depth < 4; depth++) {
      const id = attr(cur, 'id');
      if (id && /^[A-Za-z][\w-]*$/.test(id)) { parts.unshift(`#${id}`); break; }
      let part = cur.tagName.toLowerCase();
      const cls = (attr(cur, 'class') || '').split(/\s+/).filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ---------------------------------------------------------------------------
  // classification

  const CATEGORY_WORDS = [
    ['outerwear', /\b(jacket|coat|parka|blazer|puffer|trench|anorak|windbreaker|gilet|vest)\b/i],
    ['dress', /\b(dress|jumpsuit|romper|gown)\b/i],
    ['bottom', /\b(jeans?|pants?|trousers?|shorts|skirt|chinos?|leggings|joggers?|sweatpants|denim)\b/i],
    ['shoes', /\b(shoes?|sneakers?|boots?|sandals?|loafers?|heels|trainers|slides)\b/i],
    ['top', /\b(t-?shirt|tee|shirt|blouse|sweater|hoodie|sweatshirt|polo|tank|cardigan|top|crewneck|knit|pullover|henley|camisole|turtleneck)\b/i],
  ];
  const OUT_OF_SCOPE = /(^|[\/\s_-])(kids?|girls?|boys?|baby|babies|toddlers?|infants?|maternity|junior|youth)([\/\s_-]|$)/i;
  const LISTING_PATH = /\/(collections|category|categories|c|shop|search|catalog)(\/[^\/]*)?\/?$/i;

  function categorize(text) {
    for (const [cat, re] of CATEGORY_WORDS) {
      const m = String(text || '').match(re);
      if (m) {
        let sub = m[1].toLowerCase().replace(/^tee$/, 't-shirt').replace(/^tshirt$/, 't-shirt');
        if (cat === 'bottom') sub = sub.replace(/^(jean|pant|trouser|chino|jogger)$/, '$1s');
        else if (sub !== 'dress') sub = sub.replace(/s$/, '');
        return { category: cat, subcategory: sub };
      }
    }
    return null;
  }

  function sectionOf(text) {
    const s = String(text || '').toLowerCase();
    if (/(^|[\/\s_-])(women|womens|woman|ladies)([\/\s_'-]|$)/.test(s)) return 'women';
    if (/(^|[\/\s_-])(men|mens|man)([\/\s_'-]|$)/.test(s)) return 'men';
    if (/(^|[\/\s_-])unisex([\/\s_-]|$)/.test(s)) return 'unisex';
    return null;
  }

  function breadcrumbs(doc) {
    const el = $(doc, 'nav[aria-label*="readcrumb" i], [class*="breadcrumb" i], ol[itemtype*="BreadcrumbList"]');
    return el ? txt(el) : '';
  }

  // ---------------------------------------------------------------------------
  // tier 0: Shopify /products/<handle>.js

  function isShopify(doc, url) {
    if ($(doc, 'link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], meta[name="shopify-digital-wallet"], meta[name="shopify-checkout-api-token"]')) return true;
    return $$(doc, 'script:not([src])').some((s) => /Shopify\.shop\s*=/.test(s.textContent || '')) && /\/products\//.test(url);
  }

  function shopifyHandleUrl(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^(.*\/products\/[^\/?#.]+)/);
      return m ? `${u.origin}${m[1]}.js` : null;
    } catch (_) { return null; }
  }

  function applyShopify(product, j, ctx) {
    const S = 'shopifyJson';
    fill(product, 'identity.brand', j.vendor, S);
    fill(product, 'identity.name', j.title, S);
    fill(product, 'identity.productId', j.id != null ? String(j.id) : null, S);
    if (j.price != null) fill(product, 'price', { amount: Number(j.price) / 100, currency: ctx.currency || null }, S);
    const img = j.featured_image || (j.images && j.images[0]);
    if (img) fill(product, 'image', img.startsWith('//') ? `https:${img}` : img, S);

    const opts = (j.options || []).map((o, i) => (typeof o === 'string' ? { name: o, position: i + 1 } : { ...o, position: o.position || i + 1 }));
    const sizeOpt = opts.find((o) => /size|waist|taille|größe|talla/i.test(o.name || ''));
    if (sizeOpt && Array.isArray(j.variants)) {
      const key = `option${sizeOpt.position}`;
      const byLabel = new Map();
      for (const v of j.variants) {
        const label = v[key];
        if (label == null) continue;
        const prev = byLabel.get(label);
        byLabel.set(label, { label: String(label), available: (prev && prev.available) || v.available !== false, selected: false });
      }
      const options = [...byLabel.values()];
      if (options.length) fill(product, 'sizes.options', options, S);
    }

    const tags = Array.isArray(j.tags) ? j.tags.join(' ') : (j.tags || '');
    const cat = categorize(`${j.type || ''} ${j.title || ''}`);
    if (cat) { fill(product, 'identity.category', cat.category, S); fill(product, 'identity.subcategory', cat.subcategory, S); }
    fill(product, 'identity.section', sectionOf(`${tags} ${j.type || ''}`), S);

    const body = j.description || j.body_html;
    if (body && ctx.parseHtml) {
      const frag = ctx.parseHtml(String(body));
      const chart = findChart(frag);
      if (chart) fill(product, 'sizeChart', chart, S);
      const text = txt(frag.body || frag);
      fill(product, 'fabric', parseFabric(text), S);
      fill(product, 'modelRef', parseModelRef(text), S);
      fill(product, 'identity.cutHint', parseCut(`${j.title || ''} ${text}`), S);
    }
  }

  // ---------------------------------------------------------------------------
  // tier 1: JSON-LD

  function jsonLdNodes(doc) {
    const out = [];
    for (const s of $$(doc, 'script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch (_) { continue; }
      const stack = Array.isArray(data) ? data.slice() : [data];
      while (stack.length) {
        const n = stack.shift();
        if (!n || typeof n !== 'object') continue;
        out.push(n);
        if (Array.isArray(n['@graph'])) stack.push(...n['@graph']);
      }
    }
    return out;
  }

  const typeIs = (n, t) => [].concat(n['@type'] || []).some((x) => String(x).toLowerCase() === t.toLowerCase());
  const nameOf = (v) => (v == null ? null : typeof v === 'string' ? v : v.name || null);

  function applyJsonLd(product, nodes, ctx) {
    const S = 'jsonld';
    const p = nodes.find((n) => typeIs(n, 'ProductGroup')) || nodes.find((n) => typeIs(n, 'Product'));
    if (!p) return;
    fill(product, 'identity.brand', nameOf(p.brand) || nameOf(p.manufacturer), S);
    fill(product, 'identity.name', p.name, S);
    fill(product, 'identity.productId', p.productGroupID || p.sku || p.productID || p.mpn || null, S);
    const img = Array.isArray(p.image) ? p.image[0] : p.image;
    fill(product, 'image', typeof img === 'object' && img ? img.url : img, S);

    const offers = [].concat(p.offers || []).flatMap((o) => (o && o.offers ? [].concat(o.offers) : [o])).filter(Boolean);
    const o = offers[0];
    if (o && (o.price != null || o.lowPrice != null)) {
      fill(product, 'price', { amount: Number(o.price != null ? o.price : o.lowPrice), currency: o.priceCurrency || null }, S);
    }
    ctx.currency = ctx.currency || (o && o.priceCurrency);

    // Variant sizes (ProductGroup.hasVariant, or Product with size per offer).
    const variants = [].concat(p.hasVariant || []);
    const fromVariants = variants.map((v) => ({
      label: v.size || propValue(v, /size/i),
      available: availabilityOf(v.offers),
    })).filter((v) => v.label);
    const options = dedupe(fromVariants.length ? fromVariants : []);
    if (options.length) fill(product, 'sizes.options', options, S);

    const cat = categorize(`${nameOf(p.category) || ''} ${p.name || ''}`);
    if (cat) { fill(product, 'identity.category', cat.category, S); fill(product, 'identity.subcategory', cat.subcategory, S); }
    const audience = p.audience && (p.audience.suggestedGender || p.audience.audienceType);
    fill(product, 'identity.section', sectionOf(audience || ''), S);
    if (p.description) {
      fill(product, 'fabric', parseFabric(p.description), S);
      fill(product, 'identity.cutHint', parseCut(`${p.name || ''} ${p.description}`), S);
    }
    if (p.aggregateRating && p.aggregateRating.reviewCount != null && product.reviewFit.n == null) {
      product.reviewFit.n = Number(p.aggregateRating.reviewCount) || null;
    }
  }

  function propValue(node, re) {
    const props = [].concat(node.additionalProperty || []);
    const hit = props.find((x) => x && re.test(x.name || ''));
    return hit ? hit.value : null;
  }

  function availabilityOf(offers) {
    const o = [].concat(offers || [])[0];
    if (!o || !o.availability) return true;
    return !/OutOfStock|SoldOut|Discontinued/i.test(o.availability);
  }

  function dedupe(options) {
    const map = new Map();
    for (const o of options) {
      const label = String(o.label).trim();
      if (!sizes.isSizeLabel(label)) continue;
      const prev = map.get(label);
      if (!prev) map.set(label, { label, available: o.available !== false, selected: !!o.selected });
      else { prev.available = prev.available && o.available !== false; prev.selected = prev.selected || !!o.selected; }
    }
    return [...map.values()];
  }

  // ---------------------------------------------------------------------------
  // tier 2: embedded state blobs (__NEXT_DATA__, __NUXT__, digitalData, JSON scripts)

  function stateBlobs(doc) {
    const blobs = [];
    const next = $(doc, 'script#__NEXT_DATA__');
    if (next) { try { blobs.push(JSON.parse(next.textContent)); } catch (_) { /* skip */ } }
    for (const s of $$(doc, 'script[type="application/json"]')) {
      if (s === next || (s.textContent || '').length > 3e6) continue;
      try { blobs.push(JSON.parse(s.textContent)); } catch (_) { /* skip */ }
    }
    for (const s of $$(doc, 'script:not([src])')) {
      const t = s.textContent || '';
      const m = t.match(/(?:window\.)?(?:digitalData|__NUXT__|__INITIAL_STATE__|__PRELOADED_STATE__)\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (m) { try { blobs.push(JSON.parse(m[1])); } catch (_) { /* not plain JSON */ } }
    }
    return blobs;
  }

  function walk(node, visit, depth = 0, seen = new Set()) {
    if (!node || typeof node !== 'object' || depth > 14 || seen.has(node)) return;
    seen.add(node);
    if (visit(node) === false) return;
    for (const k of Object.keys(node)) walk(node[k], visit, depth + 1, seen);
  }

  const SIZE_KEYS = /^(sizes|sizeOptions|availableSizes|size_options|sizeVariants|sizeList)$/i;
  const LABEL_KEYS = ['label', 'displayName', 'name', 'value', 'size', 'sizeLabel', 'title'];
  const AVAIL_KEYS = ['available', 'inStock', 'isAvailable', 'orderable', 'isInStock'];

  function labelFrom(x) {
    if (typeof x === 'string' || typeof x === 'number') return String(x);
    if (x && typeof x === 'object') for (const k of LABEL_KEYS) if (typeof x[k] === 'string' || typeof x[k] === 'number') return String(x[k]);
    return null;
  }
  function availFrom(x) {
    if (!x || typeof x !== 'object') return true;
    for (const k of AVAIL_KEYS) if (typeof x[k] === 'boolean') return x[k];
    if (typeof x.stock === 'number') return x.stock > 0;
    if (typeof x.quantity === 'number') return x.quantity > 0;
    return true;
  }

  function applyState(product, blobs) {
    const S = 'stateBlob';
    for (const blob of blobs) {
      walk(blob, (n) => {
        if (Array.isArray(n)) return;
        // identity: first object with string brand + name
        const brand = typeof n.brand === 'string' ? n.brand : n.brand && typeof n.brand.name === 'string' ? n.brand.name : null;
        if (brand && typeof n.name === 'string' && n.name.length < 200) {
          fill(product, 'identity.brand', brand, S);
          fill(product, 'identity.name', n.name, S);
          const id = n.productId || n.sku || n.styleId || n.id;
          if (typeof id === 'string' || typeof id === 'number') fill(product, 'identity.productId', String(id), S);
          const pr = n.price;
          const amount = typeof pr === 'number' ? pr : pr && (pr.value != null ? pr.value : pr.amount != null ? pr.amount : pr.current);
          if (typeof amount === 'number') fill(product, 'price', { amount, currency: (pr && pr.currency) || n.currency || null }, S);
        }
        for (const k of Object.keys(n)) {
          const v = n[k];
          if (SIZE_KEYS.test(k) && Array.isArray(v) && v.length >= 2) {
            const opts = dedupe(v.map((x) => ({ label: labelFrom(x), available: availFrom(x) })).filter((o) => o.label));
            if (opts.length >= 2) fill(product, 'sizes.options', opts, S);
          }
          if (/^(variants|skus)$/i.test(k) && Array.isArray(v) && v.length >= 2) {
            const opts = dedupe(v.map((x) => {
              if (!x || typeof x !== 'object') return null;
              const sizeVal = x.size || (x.attributes && x.attributes.size) || x.sizeLabel;
              return sizeVal ? { label: labelFrom(sizeVal), available: availFrom(x) } : null;
            }).filter((o) => o && o.label));
            if (opts.length >= 2) fill(product, 'sizes.options', opts, S);
          }
          if (/^(sizeChart|size_chart|sizeGuide|sizeChartData)$/i.test(k) && v && typeof v === 'object') {
            const chart = chartFromJson(v);
            if (chart) fill(product, 'sizeChart', chart, S);
          }
          if (/^(fitRating|sizeFit|fitScore|trueToSizeRating)$/i.test(k) && typeof v === 'number') {
            // Assume a 1..5 scale centred on 3 unless it is already -1..1.
            const scale = v >= -1 && v <= 1 ? v : Math.max(-1, Math.min(1, (v - 3) / 2));
            const count = [n.count, n.reviewCount, n.totalReviews, n.total].find((c) => typeof c === 'number') || null;
            if (count && product.reviewFit.n == null) product.reviewFit.n = count;
            fill(product, 'reviewFit.aggregate', { scale: +scale.toFixed(2), label: scaleLabel(scale), n: count, source: 'stateBlob' }, S);
          }
        }
      });
    }
  }

  function chartFromJson(v) {
    const rows = Array.isArray(v) ? v : Array.isArray(v.rows) ? v.rows : null;
    if (!rows || !rows.length) return null;
    const out = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const size = labelFrom(r.size != null ? r.size : r);
      if (!size) continue;
      const row = { size };
      for (const [k, val] of Object.entries(r)) {
        const key = measureKey(k);
        const num = parseMeasure(val);
        if (key && num != null) row[key] = num;
      }
      if (Object.keys(row).length > 1) out.push(row);
    }
    if (!out.length) return null;
    const ctx = JSON.stringify(v).slice(0, 2000);
    return { kind: chartKind(ctx), unit: /cm/i.test(ctx) ? 'cm' : /inch|"in"|\bin\b/i.test(ctx) ? 'in' : null, rows: out, imageOnly: false };
  }

  // ---------------------------------------------------------------------------
  // tier 3: review platform widgets

  const REVIEW_PLATFORMS = [
    ['okendo', '[data-oke-widget], [class*="okeReviews"], [class*="oke-w"]'],
    ['yotpo', '.yotpo, [class*="yotpo-"]'],
    ['judgeme', '.jdgm-widget, [class*="jdgm-"]'],
    ['bazaarvoice', '[data-bv-show], [id^="BVRR"], [class*="bv_"], [class*="bv-"]'],
    ['powerreviews', '#pr-reviewdisplay, .pr-review-snapshot, [class*="pr-review"]'],
    ['stamped', '#stamped-main-widget, [class*="stamped-"]'],
    ['loox', '#looxReviews'],
    ['generic', '#reviews, [id*="review" i], [class*="reviews" i], [data-reviews]'],
  ];

  const FIT_WORD = '(runs?\\s*(?:a\\s*(?:bit|little)\\s*|slightly\\s*)?small|true\\s*to\\s*size|runs?\\s*(?:a\\s*(?:bit|little)\\s*|slightly\\s*)?(?:large|big)|too\\s*small|too\\s*(?:large|big)|perfect|just\\s*right)';

  function fitCategory(word) {
    const w = word.toLowerCase();
    if (/small/.test(w)) return 'runsSmall';
    if (/large|big/.test(w)) return 'runsLarge';
    return 'trueToSize';
  }
  function scaleLabel(s) { return s <= -0.25 ? 'runs small' : s >= 0.25 ? 'runs large' : 'true to size'; }

  function reviewRegion(doc, config) {
    if (config && config.reviewContainer) {
      const el = $(doc, config.reviewContainer);
      if (el) return { platform: config.reviewPlatform || 'config', el };
    }
    for (const [platform, sel] of REVIEW_PLATFORMS) {
      const els = $$(doc, sel).filter((e) => txt(e).length > 20);
      if (els.length) {
        // The outermost match holds the whole widget.
        const el = els.find((e) => !els.some((o) => o !== e && o.contains && o.contains(e))) || els[0];
        return { platform, el };
      }
    }
    return null;
  }

  function applyReviews(product, doc, config) {
    const S = 'reviewWidget';
    const region = reviewRegion(doc, config);
    if (!region) return null;
    const text = txt(region.el);

    // Explicit distribution: "Runs small 62%" or "62% said it runs small".
    const dist = {};
    const fwd = new RegExp(`${FIT_WORD}\\s*[:\\-\\u2013]?\\s*\\(?\\s*(\\d{1,3})\\s*%`, 'gi');
    const rev = new RegExp(`(\\d{1,3})\\s*%\\s*(?:of\\s*(?:reviewers|customers|buyers|shoppers)\\s*)?(?:said|say|says)?\\s*(?:it\\s*)?${FIT_WORD}`, 'gi');
    let m;
    while ((m = fwd.exec(text))) dist[fitCategory(m[1])] = dist[fitCategory(m[1])] == null ? Number(m[2]) / 100 : dist[fitCategory(m[1])];
    while ((m = rev.exec(text))) dist[fitCategory(m[2])] = dist[fitCategory(m[2])] == null ? Number(m[1]) / 100 : dist[fitCategory(m[2])];

    const nMatch = text.match(/(?:based\s*on\s*)?(\d[\d,]*)\s*(?:reviews|ratings)/i);
    const n = nMatch ? Number(nMatch[1].replace(/,/g, '')) : null;
    if (n && product.reviewFit.n == null) product.reviewFit.n = n;

    if (Object.keys(dist).length >= 2) {
      fill(product, 'reviewFit.distribution', { runsSmall: dist.runsSmall || 0, trueToSize: dist.trueToSize || 0, runsLarge: dist.runsLarge || 0 }, S);
    }

    // Fit slider/meter (e.g. a "How it fits" scale).
    for (const el of $$(region.el, '[role="meter"], [role="slider"], [aria-valuenow]')) {
      const label = `${attr(el, 'aria-label') || ''} ${txt(el.parentElement)}`;
      if (!/fit|size|sizing/i.test(label)) continue;
      const now = Number(attr(el, 'aria-valuenow'));
      const min = Number(attr(el, 'aria-valuemin') || 0);
      const max = Number(attr(el, 'aria-valuemax') || 100);
      if (!isFinite(now) || max <= min) continue;
      const scale = ((now - min) / (max - min)) * 2 - 1;
      fill(product, 'reviewFit.aggregate', { scale: +scale.toFixed(2), label: scaleLabel(scale), n, source: region.platform }, S);
      break;
    }

    // Aggregate label: "Fit: Runs small" / "Sizing: True to size" at the widget summary level.
    const agg = text.match(new RegExp(`(?:overall\\s*fit|sizing|fit|how\\s*it\\s*fits)\\s*[:\\-]\\s*${FIT_WORD}`, 'i'));
    const items = reviewItems(region.el);
    if (agg && !items.length) {
      const cat = fitCategory(agg[1]);
      const scale = cat === 'runsSmall' ? -1 : cat === 'runsLarge' ? 1 : 0;
      fill(product, 'reviewFit.aggregate', { scale, label: scaleLabel(scale), n, source: region.platform }, S);
    }

    // Per-review facts: verdict, size bought, height. Never the review text itself.
    const reviewers = [];
    for (const it of items) {
      const t = txt(it);
      const v = t.match(new RegExp(`(?:fit|sizing|how\\s*it\\s*fits|size)\\s*[:\\-]?\\s*${FIT_WORD}`, 'i'));
      const sz = t.match(/size\s*(?:purchased|bought|ordered|worn)\s*[:\-]?\s*([A-Za-z0-9\/.]{1,6})\b/i);
      const hFt = t.match(/height\s*[:\-]?\s*(\d)\s*(?:'|’|ft)\s*(\d{1,2})?/i);
      const hCm = t.match(/height\s*[:\-]?\s*(1\d{2})\s*cm/i);
      if (!v && !sz) continue;
      reviewers.push({
        heightCm: hCm ? Number(hCm[1]) : hFt ? Math.round((Number(hFt[1]) * 12 + Number(hFt[2] || 0)) * 2.54) : null,
        weightKg: null,
        sizeBought: sz ? sz[1] : null,
        fitVerdict: v ? fitCategory(v[1]).replace('runsSmall', 'small').replace('runsLarge', 'large').replace('trueToSize', 'perfect') : null,
      });
    }
    if (reviewers.length) fill(product, 'reviewFit.reviewers', reviewers, S);
    return region.platform;
  }

  function reviewItems(root) {
    return $$(root, '[itemprop="review"], .oke-w-review, .jdgm-rev, .yotpo-review, .stamped-review, li[class*="review" i], article[class*="review" i], div[class*="review-item" i], div[class*="reviewItem"]');
  }

  // ---------------------------------------------------------------------------
  // tier 4: DOM heuristics

  const CHOICE_SEL = 'button, [role="radio"], [role="option"], input[type="radio"], label, li[data-value], a[data-value], [data-size], span[data-value]';

  function choiceLabel(el) {
    const candidates = [attr(el, 'data-size'), attr(el, 'data-value'), txt(el), attr(el, 'aria-label'), attr(el, 'value'), attr(el, 'title')];
    for (const c of candidates) {
      if (!c) continue;
      const clean = String(c).replace(/^\s*(select\s*)?size[:\s]*/i, '').replace(/\s*[-,(]?\s*(sold\s*out|out\s*of\s*stock|unavailable|notify\s*me|low\s*stock|only\s*\d+\s*left)\)?\s*$/i, '').trim();
      if (sizes.isSizeLabel(clean)) return clean;
    }
    return null;
  }

  function isUnavailable(el) {
    if (el.disabled || attr(el, 'disabled') != null || attr(el, 'aria-disabled') === 'true') return true;
    const cls = `${attr(el, 'class') || ''} ${attr(el, 'data-state') || ''}`;
    if (/(sold-?out|unavailable|disabled|out-of-stock|oos|is-disabled|crossed)/i.test(cls)) return true;
    return /sold\s*out|out\s*of\s*stock|unavailable/i.test(`${attr(el, 'aria-label') || ''} ${attr(el, 'title') || ''}`);
  }

  function isSelected(el) {
    if (attr(el, 'aria-checked') === 'true' || attr(el, 'aria-pressed') === 'true' || attr(el, 'aria-selected') === 'true') return true;
    if (el.checked === true || (el.tagName === 'INPUT' && attr(el, 'checked') != null)) return true;
    return /(^|\s)(selected|is-selected|active|is-active|checked|current)(\s|$)/i.test(attr(el, 'class') || '');
  }

  function sizeAncestor(el, stop) {
    let cur = el.parentElement;
    for (let i = 0; cur && cur !== stop && i < 6; i++) {
      const sig = `${attr(cur, 'class') || ''} ${attr(cur, 'id') || ''} ${attr(cur, 'aria-label') || ''} ${attr(cur, 'data-option-name') || ''} ${attr(cur, 'name') || ''} ${attr(cur, 'data-testid') || ''}`;
      if (/size/i.test(sig)) return cur;
      if (cur.tagName === 'FIELDSET') {
        const legend = $(cur, 'legend');
        if (legend && /size/i.test(txt(legend))) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /** Find the size control. Returns { options, container, selector, docked } or null. */
  function findSizeControl(doc, config) {
    const root = (config && config.sizeControl && $(doc, config.sizeControl)) || doc;

    // <select name="size"> is the most reliable when present.
    for (const sel of $$(root, 'select')) {
      const sig = `${attr(sel, 'name') || ''} ${attr(sel, 'id') || ''} ${attr(sel, 'aria-label') || ''} ${attr(sel, 'class') || ''}`;
      const labelEl = attr(sel, 'id') ? $(doc, `label[for="${attr(sel, 'id')}"]`) : null;
      if (!/size|waist/i.test(sig) && !(labelEl && /size/i.test(txt(labelEl)))) continue;
      const opts = dedupe($$(sel, 'option').map((o) => ({
        label: (txt(o) || attr(o, 'value') || '').replace(/\s*[-(]?\s*(sold\s*out|out\s*of\s*stock|unavailable)\)?\s*$/i, '').trim(),
        available: !o.disabled && attr(o, 'disabled') == null && !/sold\s*out|unavailable/i.test(txt(o)),
        selected: o.selected === true && attr(o, 'value') !== '',
      })));
      if (opts.length >= 1) return { options: opts, container: sel, selector: cssPath(sel), docked: true };
    }

    const groups = new Map();
    for (const el of $$(root, CHOICE_SEL)) {
      const label = choiceLabel(el);
      if (!label) continue;
      const anc = sizeAncestor(el, root === doc ? null : root.parentElement) || (root !== doc ? root : null);
      const key = anc || el.parentElement;
      if (!groups.has(key)) groups.set(key, { anchored: !!anc, items: [] });
      groups.get(key).items.push({ label, available: !isUnavailable(el), selected: isSelected(el) });
    }
    let best = null;
    for (const [container, g] of groups) {
      const opts = dedupe(g.items);
      const scoreG = opts.length + (g.anchored ? 10 : 0);
      if ((g.anchored ? opts.length >= 1 : opts.length >= 2) && (!best || scoreG > best.score)) {
        best = { score: scoreG, options: opts, container, anchored: g.anchored };
      }
    }
    if (best) return { options: best.options, container: best.container, selector: cssPath(best.container), docked: best.anchored || !!(config && config.sizeControl) };
    return null;
  }

  /** Floor fallback: any run of 2+ size-looking buttons anywhere on the page. */
  function regexSizeFallback(doc) {
    const labels = $$(doc, 'button, [role="button"], li, a').map((e) => txt(e)).filter((t) => t.length <= 6 && sizes.isSizeLabel(t));
    const opts = dedupe(labels.map((label) => ({ label, available: true })));
    const system = sizes.detectSystem(opts.map((o) => o.label));
    return opts.length >= 2 && system !== 'unknown' ? opts : null;
  }

  /** Read the currently selected size from the live page (used on every click). */
  function readSelection(doc, product, config) {
    const ctl = findSizeControl(doc, config);
    if (!ctl) return null;
    const sel = ctl.options.find((o) => o.selected);
    return sel ? sel.label : null;
  }

  const MEASURES = [
    [/pit\s*to\s*pit|armpit|half\s*chest|across\s*chest|chest\s*width/i, 'pitToPit'],
    [/chest|bust/i, 'chest'],
    [/waist/i, 'waist'],
    [/hips?|seat/i, 'hip'],
    [/inseam|inside\s*leg/i, 'inseam'],
    [/rise/i, 'rise'],
    [/sleeve/i, 'sleeve'],
    [/shoulder/i, 'shoulder'],
    [/thigh/i, 'thigh'],
    [/(body\s*)?length|front\s*length|back\s*length/i, 'bodyLength'],
  ];
  function measureKey(h) {
    for (const [re, key] of MEASURES) if (re.test(String(h))) return key;
    return null;
  }
  function parseMeasure(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return null;
    const s = v.replace(/,/g, '.').replace(/½/g, '.5').replace(/\s+1\/2/g, '.5').replace(/\s+1\/4/g, '.25').replace(/\s+3\/4/g, '.75');
    const range = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
    if (range) return (Number(range[1]) + Number(range[2])) / 2;
    const one = s.match(/(\d+(?:\.\d+)?)/);
    return one ? Number(one[1]) : null;
  }
  function chartKind(context) {
    if (/garment|product\s*measurement|laid\s*flat|pit\s*to\s*pit|flat\s*measurement|item\s*measurement|measured\s*flat/i.test(context)) return 'garment';
    if (/body\s*measurement|to\s*fit|your\s*measurement|fits\s*(bust|chest|waist)|body\s*size|measure\s*yourself/i.test(context)) return 'body';
    return 'unknown';
  }

  function parseChartTable(table) {
    let grid = $$(table, 'tr').map((tr) => $$(tr, 'th, td').map((c) => txt(c)));
    grid = grid.filter((r) => r.length >= 2);
    if (grid.length < 2) return null;
    // Transposed: sizes across the header row.
    const headerSizes = grid[0].slice(1).filter((c) => sizes.isSizeLabel(c)).length;
    if (headerSizes >= 2 && headerSizes >= grid[0].length - 2) {
      grid = grid[0].map((_, i) => grid.map((r) => r[i] || ''));
    }
    const header = grid[0];
    const sizeCol = header.findIndex((h) => /size/i.test(h));
    const sc = sizeCol >= 0 ? sizeCol : 0;
    const cols = header.map((h, i) => (i === sc ? null : measureKey(h)));
    if (!cols.some(Boolean)) return null;
    const rows = [];
    for (const r of grid.slice(1)) {
      const size = (r[sc] || '').trim();
      if (!sizes.isSizeLabel(size)) continue;
      const row = { size };
      cols.forEach((k, i) => { if (k) { const n = parseMeasure(r[i]); if (n != null) row[k] = n; } });
      if (Object.keys(row).length > 1) rows.push(row);
    }
    if (rows.length < 2) return null;
    const context = `${txt(table)} ${txt($(table, 'caption'))} ${txt(table.previousElementSibling)} ${txt(table.parentElement).slice(0, 400)}`;
    const unit = /\bcm\b|centimet/i.test(context) ? 'cm' : /\binch|\bin\b|"/i.test(context) ? 'in' : (rows[0].chest > 60 || rows[0].waist > 50 ? 'cm' : 'in');
    return { kind: chartKind(context), unit, rows, imageOnly: false };
  }

  function findChart(root) {
    for (const t of $$(root, 'table')) {
      const c = parseChartTable(t);
      if (c) return c;
    }
    return null;
  }

  function findChartImage(doc) {
    return $$(doc, 'img').some((img) => /size[\s_-]?(chart|guide)/i.test(`${attr(img, 'alt') || ''} ${attr(img, 'src') || ''}`));
  }

  const FIBERS = 'cotton|polyester|elastane|spandex|lycra|nylon|polyamide|wool|merino|linen|viscose|rayon|modal|lyocell|tencel|cashmere|silk|acrylic|hemp|leather|bamboo';
  function parseFabric(text) {
    const re = new RegExp(`(\\d{1,3})\\s*%\\s*(?:recycled\\s*|organic\\s*)?(${FIBERS})`, 'gi');
    const comp = [];
    let m, total = 0, lastEnd = -1;
    while ((m = re.exec(String(text || '')))) {
      if (lastEnd >= 0 && m.index - lastEnd > 60) break; // only the first composition block
      const material = m[2].toLowerCase();
      if (comp.some((c) => c.material === material)) continue;
      comp.push({ material, pct: Number(m[1]) });
      total += Number(m[1]);
      lastEnd = m.index + m[0].length;
      if (total >= 100) break;
    }
    if (!comp.length) return null;
    const stretch = comp.some((c) => /elastane|spandex|lycra/.test(c.material)) || /\bstretch\b/i.test(text);
    return { composition: comp, stretch };
  }

  function parseModelRef(text) {
    const m = String(text || '').match(/model\s*(?:is|'s\s*height\s*is|height[:\s]*|stands)\s*(?:(\d)\s*(?:'|’|ft)\s*(\d{1,2})?\s*(?:"|”|in)?|(1\d{2})\s*cm)[^.]{0,80}?(?:wear(?:s|ing)?|in)\s*(?:a\s*)?(?:size\s*)?([A-Z0-9]{1,4})\b/i);
    if (!m) return null;
    const heightCm = m[3] ? Number(m[3]) : Math.round((Number(m[1]) * 12 + Number(m[2] || 0)) * 2.54);
    return sizes.isSizeLabel(m[4]) ? { heightCm, sizeWorn: m[4] } : null;
  }

  function parseCut(text) {
    const m = String(text || '').match(/\b(oversized|relaxed|boxy|loose|baggy|slim|skinny|fitted|regular|straight|cropped|athletic|tapered|wide[\s-]leg)\b(?:[\s-]*fit)?/i);
    return m ? m[1].toLowerCase() : null;
  }

  function descriptionText(doc) {
    const el = $(doc, '[itemprop="description"], [class*="product-description" i], [class*="productDescription"], [id*="description" i], [class*="product__description" i], [class*="details" i], [id*="details" i]');
    return `${meta(doc, 'og:description') || ''} ${meta(doc, 'description') || ''} ${el ? txt(el).slice(0, 4000) : ''}`;
  }

  function applyDom(product, doc, url, config) {
    const D = 'dom';
    // Floor: brand and name from meta tags and headings.
    fill(product, 'identity.brand', meta(doc, 'product:brand') || meta(doc, 'og:brand'), D);
    fill(product, 'identity.brand', meta(doc, 'og:site_name'), D);
    const h1 = $(doc, 'h1');
    fill(product, 'identity.name', meta(doc, 'og:title') || (h1 && txt(h1)) || ((doc.title || '').split(/\s[|\-–]\s/)[0] || '').trim(), D);
    const priceAmt = meta(doc, 'product:price:amount') || meta(doc, 'og:price:amount');
    if (priceAmt) fill(product, 'price', { amount: Number(priceAmt), currency: meta(doc, 'product:price:currency') || meta(doc, 'og:price:currency') }, D);
    fill(product, 'image', meta(doc, 'og:image'), D);

    const ctl = findSizeControl(doc, config);
    if (ctl) {
      if (!fill(product, 'sizes.options', ctl.options, D) && product.sizes.options) {
        // A structured tier set the options; take live availability/selection from the DOM.
        for (const o of product.sizes.options) {
          const live = ctl.options.find((c) => c.label === o.label);
          if (live) { o.selected = live.selected; if (live.available === false) o.available = false; }
        }
      }
      product.sizes.selector = ctl.selector;
      product.sizes.docked = ctl.docked;
    } else {
      const fb = regexSizeFallback(doc);
      if (fb) { fill(product, 'sizes.options', fb, D); product.sizes.docked = false; }
    }

    const chart = findChart(doc);
    if (chart) fill(product, 'sizeChart', chart, 'domTable');
    else if (findChartImage(doc)) fill(product, 'sizeChart', { kind: 'unknown', unit: null, rows: [], imageOnly: true }, D);

    const desc = descriptionText(doc);
    fill(product, 'fabric', parseFabric(desc), D);
    fill(product, 'modelRef', parseModelRef(desc) || parseModelRef(txt(doc.body).slice(0, 20000)), D);
    fill(product, 'identity.cutHint', parseCut(`${product.identity.name || ''} ${desc}`), D);

    const crumbs = breadcrumbs(doc);
    const cat = categorize(product.identity.name) || categorize(crumbs) || categorize(url);
    if (cat) { fill(product, 'identity.category', cat.category, D); fill(product, 'identity.subcategory', cat.subcategory, D); }
    let path = '';
    try { path = new URL(url).pathname; } catch (_) { /* ignore */ }
    fill(product, 'identity.section', (config && config.section) || sectionOf(path) || sectionOf(crumbs), D);
  }

  function applyFallbacks(product) {
    if (!product.identity.brand && product.host) {
      const base = product.host.split('.').slice(-2, -1)[0] || product.host;
      fill(product, 'identity.brand', base.charAt(0).toUpperCase() + base.slice(1), 'fallback');
    }
    const opts = product.sizes.options;
    if (opts && opts.length && !product.sizes.system) product.sizes.system = sizes.detectSystem(opts.map((o) => o.label));
    return product;
  }

  // ---------------------------------------------------------------------------
  // page classification

  function classify(doc, url, nodes) {
    let path = '';
    try { path = new URL(url).pathname; } catch (_) { /* ignore */ }
    const hasProductLd = nodes.some((n) => typeIs(n, 'Product') || typeIs(n, 'ProductGroup'));
    const productLdCount = nodes.filter((n) => typeIs(n, 'Product')).length;
    const itemList = nodes.some((n) => typeIs(n, 'ItemList') || typeIs(n, 'CollectionPage'));
    const ogProduct = /product/i.test(meta(doc, 'og:type') || '');
    const shopifyProduct = /\/products\/[^\/]+/.test(path);
    const addButtons = $$(doc, 'button, input[type="submit"]').filter((b) => /add\s*to\s*(cart|bag|basket)/i.test(txt(b) || attr(b, 'value') || '')).length;

    const scopeText = `${path} ${breadcrumbs(doc)} ${(meta(doc, 'og:title') || '')}`;
    if (OUT_OF_SCOPE.test(scopeText)) return { isProduct: false, outOfScope: true, reason: 'children-or-maternity' };

    if (itemList && !hasProductLd) return { isProduct: false, reason: 'listing' };
    if (productLdCount > 3) return { isProduct: false, reason: 'listing' };
    if (addButtons > 4) return { isProduct: false, reason: 'listing' };
    if (hasProductLd || ogProduct || shopifyProduct) return { isProduct: true };
    if (LISTING_PATH.test(path)) return { isProduct: false, reason: 'listing' };
    if (addButtons >= 1 && findSizeControl(doc, null)) return { isProduct: true };
    return { isProduct: false, reason: 'not-a-product' };
  }

  // ---------------------------------------------------------------------------
  // entry point

  /**
   * Run tiers 0-4. Returns:
   *   { ok: true, product, tiers }                     floor satisfied
   *   { ok: false, reason, missing, product, tiers }   explicit failure (never a half-filled "success")
   *   { ok: false, reason: 'listing'|'not-a-product'|'children-or-maternity', silent: true }
   */
  async function extract(doc, opts) {
    opts = opts || {};
    const url = opts.url || (doc.location && doc.location.href) || '';
    const config = opts.config || {};
    const nodes = jsonLdNodes(doc);
    const cls = classify(doc, url, nodes);
    if (!cls.isProduct) return { ok: false, silent: true, reason: cls.reason };

    const product = contract.emptyProduct(url, opts.now);
    const ctx = { parseHtml: opts.parseHtml || (typeof DOMParser !== 'undefined' ? (s) => new DOMParser().parseFromString(s, 'text/html') : null), currency: null };
    const tiers = {};
    const t = (name, fn) => { const before = Object.keys(product._src).length; try { fn(); } catch (e) { tiers[name] = `error: ${e.message}`; return; } tiers[name] = Object.keys(product._src).length - before; };

    // Tier 1 first only to learn currency; tier 0 still wins conflicts because fill() is
    // order-sensitive, so run tier 0 before applying tier 1's fields.
    if (isShopify(doc, url) && opts.fetchJson) {
      const handleUrl = shopifyHandleUrl(url);
      let j = null;
      if (handleUrl) { try { j = await opts.fetchJson(handleUrl); } catch (_) { j = null; } }
      const ldOffer = nodes.find((n) => typeIs(n, 'Product'));
      ctx.currency = ldOffer && [].concat(ldOffer.offers || [])[0] && [].concat(ldOffer.offers)[0].priceCurrency;
      if (j) t('shopifyJson', () => applyShopify(product, j, ctx));
      else tiers.shopifyJson = 'unavailable';
    }
    t('jsonld', () => applyJsonLd(product, nodes, ctx));
    t('stateBlob', () => applyState(product, stateBlobs(doc)));
    let platform = null;
    t('reviewWidget', () => { platform = applyReviews(product, doc, config); });
    t('dom', () => applyDom(product, doc, url, config));

    if (product.sizes.options && !product.sizes.system) product.sizes.system = sizes.detectSystem(product.sizes.options.map((o) => o.label));
    const missing = contract.missingFloor(product).filter((p) => p !== 'identity.brand' || !product.host);
    if (missing.length) {
      return { ok: false, reason: 'floor-missing', missing, product, tiers, reviewPlatform: platform };
    }
    applyFallbacks(product);
    return { ok: true, product, tiers, reviewPlatform: platform };
  }

  /** Trimmed visible text for the LLM tier: product region first, capped, no scripts. */
  function trimmedText(doc, max) {
    max = max || 12000;
    const main = $(doc, 'main, [role="main"], #main, [class*="product" i]') || doc.body;
    return txt(main).slice(0, max);
  }

  return {
    extract, applyFallbacks, readSelection, findSizeControl, trimmedText, jsonLdNodes,
    // exposed for tests and the probe
    _internal: { classify, parseChartTable, parseFabric, parseModelRef, parseCut, categorize, sectionOf, applyReviews, reviewRegion, isShopify, stateBlobs, txt },
  };
});
