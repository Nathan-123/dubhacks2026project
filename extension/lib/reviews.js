/*
 * reviews — review-platform APIs -> fit facts in Product terms, or null.
 *
 * Rendered review widgets differ per store and often load late, but the platforms behind
 * them serve the same structured answers to every store. Each adapter knows one platform:
 * how to spot it on a page, which public endpoint holds its reviews, and what its fit
 * answers mean. Callers only see read().
 *
 * Only computed facts leave this module (verdicts, sizes, heights). Review text, titles and
 * names are never read out of the response. Network is injected (fetchJson) so tests stub it.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode ? { sizes: require('./sizes.js') } : root.FitKit;
  const mod = factory(deps.sizes);
  if (isNode) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).reviews = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sizes) {
  'use strict';

  const $ = (root, sel) => { try { return root.querySelector(sel); } catch (_) { return null; } };
  const $$ = (root, sel) => { try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return []; } };

  function scaleLabel(s) { return s <= -0.25 ? 'runs small' : s >= 0.25 ? 'runs large' : 'true to size'; }
  function verdictOf(s) { return s < 0 ? 'small' : s > 0 ? 'large' : 'perfect'; }

  /** "5'10-6'0", "5' 7\"", "170 cm" -> centimetres (midpoint of a band), or null. */
  function heightCm(v) {
    const s = String(v || '');
    const cm = s.match(/(1\d{2})\s*cm/i);
    if (cm) return Number(cm[1]);
    const inches = [...s.matchAll(/(\d)\s*(?:'|’|ft)\s*(\d{1,2})?/g)].map((m) => Number(m[1]) * 12 + Number(m[2] || 0));
    return inches.length ? Math.round((inches.reduce((a, b) => a + b, 0) / inches.length) * 2.54) : null;
  }

  const sizeOrNull = (v) => (v != null && sizes.isSizeLabel(String(v).trim()) ? String(v).trim() : null);

  // -------------------------------------------------------------------------
  // Yotpo (reviews widget v3). Verified on everlane.com, 2026-10-18.
  //
  // The page carries the store key in the loader script and the product id on the widget.
  // The storefront API is public and answers with CORS for the store's own origin. A "Size"
  // custom field is the fit question, 1 = runs small, 2 = true to size, 3 = runs large.

  const yotpo = {
    name: 'yotpo',
    locate(doc) {
      const widget = $(doc, '.yotpo-widget-instance[data-yotpo-product-id]');
      const loader = $$(doc, 'script[src*="cdn-widgetsrepository.yotpo.com/v1/loader/"]')
        .map((s) => (s.getAttribute('src').match(/\/loader\/([A-Za-z0-9]+)/) || [])[1]).find(Boolean);
      const productId = widget && widget.getAttribute('data-yotpo-product-id');
      if (!loader || !productId) return null;
      return `https://api-cdn.yotpo.com/v3/storefront/store/${loader}/product/${encodeURIComponent(productId)}/reviews?page=1&perPage=100`;
    },
    parse(json) {
      if (!json || !Array.isArray(json.reviews) || !json.bottomline) return null;
      const field = (r, test) => Object.values(r.customFields || {}).find((f) => f && test(f));
      const answers = json.reviews.map((r) => ({
        fit: field(r, (f) => f.fieldType === 'Size'),
        bought: field(r, (f) => /size\s*(purchased|bought|ordered|worn)/i.test(f.title || '')),
        usual: field(r, (f) => /(usual|normal|typical)(ly)?\s*(wear\s*)?size/i.test(f.title || '')),
        height: field(r, (f) => /height/i.test(f.title || '')),
      }));

      const fits = answers.map((a) => (a.fit && typeof a.fit.value === 'number' ? a.fit.value : null));
      const answered = fits.filter((v) => v != null);
      // A store can configure a 5-step fit question; its middle is then 3, not 2.
      const mid = answered.some((v) => v > 3) ? 3 : 2;
      const norm = (v) => Math.max(-1, Math.min(1, (v - mid) / (mid - 1)));

      const reviewers = answers.map((a, i) => ({
        heightCm: a.height ? heightCm(a.height.value) : null,
        weightKg: null,
        sizeBought: a.bought ? sizeOrNull(a.bought.value) : null,
        usualSize: a.usual ? sizeOrNull(a.usual.value) : null,
        fitVerdict: fits[i] != null ? verdictOf(norm(fits[i])) : null,
      })).filter((r) => r.fitVerdict || r.sizeBought);

      let distribution = null;
      let aggregate = null;
      if (answered.length) {
        const share = (pred) => +(answered.filter((v) => pred(norm(v))).length / answered.length).toFixed(2);
        distribution = { runsSmall: share((s) => s < 0), trueToSize: share((s) => s === 0), runsLarge: share((s) => s > 0) };
      } else {
        // The bottomline average is rounded, so it is only used when no review answered.
        const bl = Object.values(json.bottomline.customFieldsBottomline || {}).find((f) => f && f.type === 'Size');
        if (bl && typeof bl.averageScore === 'number' && bl.averageScore > 0) {
          const scale = +norm(bl.averageScore).toFixed(2);
          aggregate = { scale, label: scaleLabel(scale), n: json.bottomline.totalReview || null, source: 'yotpo' };
        }
      }
      if (!distribution && !aggregate && !reviewers.length) return null;
      return { distribution, aggregate, reviewers: reviewers.length ? reviewers : null, n: answered.length || json.bottomline.totalReview || null };
    },
  };

  const ADAPTERS = [yotpo];

  /**
   * Find the page's review platform and read its fit answers.
   *   -> { platform, fit: { distribution, aggregate, reviewers, n } }   any of the fit fields may be null
   *   -> null                                                           no known platform, or nothing usable
   * A network failure rejects, so the caller can report it; nothing is retried.
   */
  async function read(doc, fetchJson) {
    for (const adapter of ADAPTERS) {
      const url = adapter.locate(doc);
      if (!url) continue;
      const fit = adapter.parse(await fetchJson(url));
      return fit ? { platform: adapter.name, fit } : null;
    }
    return null;
  }

  return { read };
});
