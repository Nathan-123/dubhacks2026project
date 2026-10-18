/*
 * contract — the one normalized Product shape every extractor fills.
 *
 * Every field is nullable except the floor (brand, name, size options). Every filled
 * field records which tier filled it in _src. A tier never overwrites a field a
 * stronger (earlier) tier already set; it only fills gaps.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).contract = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Tiers, cheapest first. Lower number = stronger; used to resolve conflicts and confidence. */
  const TIERS = {
    shopifyJson: 0,
    jsonld: 1,
    stateBlob: 2,
    reviewApi: 3,
    reviewWidget: 3,
    domTable: 4,
    dom: 4,
    llm: 5,
    cache: 5,
    fallback: 7,
  };

  /** Every field path that carries provenance. A filled path without _src is a contract violation. */
  const TRACKED = [
    'identity.brand', 'identity.name', 'identity.productId', 'identity.category',
    'identity.subcategory', 'identity.section', 'identity.cutHint',
    'sizes.options', 'sizeChart', 'fabric', 'modelRef',
    'reviewFit.aggregate', 'reviewFit.distribution', 'reviewFit.reviewers',
    'price', 'image',
  ];

  const FLOOR = ['identity.brand', 'identity.name', 'sizes.options'];

  function emptyProduct(url, capturedAt) {
    let host = null;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { /* leave null */ }
    return {
      url: url || null,
      host,
      capturedAt: capturedAt || new Date().toISOString(),
      identity: { brand: null, name: null, productId: null, category: null, subcategory: null, section: null, cutHint: null },
      sizes: { system: null, options: null, selector: null },
      sizeChart: null,
      fabric: null,
      modelRef: null,
      reviewFit: { aggregate: null, distribution: null, reviewers: null, n: null },
      price: null,
      image: null,
      _src: {},
    };
  }

  function get(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function isFilled(v) {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim().length > 0;
    return true;
  }

  /**
   * Fill a field only if it is empty. Returns true when the value was written.
   * This is the only way extractors write into a Product.
   */
  function fill(product, path, value, src) {
    if (!isFilled(value)) return false;
    if (isFilled(get(product, path))) return false;
    const keys = path.split('.');
    let o = product;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null) o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
    product._src[path] = src;
    return true;
  }

  /** Paths that are filled but have no provenance. Must be empty for every Product we emit. */
  function unsourced(product) {
    return TRACKED.filter((p) => isFilled(get(product, p)) && !product._src[p]);
  }

  function missingFloor(product) {
    return FLOOR.filter((p) => !isFilled(get(product, p)));
  }

  /** Canonical URL used as the cache key: no query string, no hash, no trailing slash. */
  function canonicalUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/+$/, '') || '/';
      return `${u.protocol}//${u.hostname.replace(/^www\./, '')}${path}`;
    } catch (_) {
      return url;
    }
  }

  /**
   * Merge `extra` into `base` without overwriting anything base already has.
   * Used when the backend (cache or LLM tier) fills gaps in a partial client-side extraction.
   */
  function mergeGaps(base, extra) {
    for (const path of TRACKED) {
      const v = get(extra, path);
      if (isFilled(v)) fill(base, path, v, (extra._src && extra._src[path]) || 'llm');
    }
    if (!base.sizes.system && extra.sizes && extra.sizes.system) base.sizes.system = extra.sizes.system;
    if (base.reviewFit.n == null && extra.reviewFit && extra.reviewFit.n != null) base.reviewFit.n = extra.reviewFit.n;
    return base;
  }

  /** Summary of how strong the extraction was: the weakest tier that filled a floor field. */
  function extractionQuality(product) {
    const floorTiers = FLOOR.map((p) => TIERS[product._src[p]]).filter((t) => t != null);
    if (floorTiers.length < FLOOR.length) return 'failed';
    const worst = Math.max(...floorTiers);
    if (worst >= TIERS.fallback) return 'floor-only';
    if (worst >= TIERS.llm) return 'llm';
    return 'structured';
  }

  return { TIERS, TRACKED, FLOOR, emptyProduct, get, isFilled, fill, unsourced, missingFloor, canonicalUrl, mergeGaps, extractionQuality };
});
