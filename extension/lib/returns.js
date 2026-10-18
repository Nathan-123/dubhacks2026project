/*
 * returns — a store's return window, read from the store's own policy page.
 *
 * policyLink(document, pageUrl) finds the store's "Returns" / "Return policy" link (same store only).
 * readWindow(text) pulls "N days from delivery | shipping | purchase" out of the policy wording; when the
 * page names more than one window (a holiday extension, a shorter one for sale items) it says so with
 * sure: false, and the caller asks the backend model instead of guessing.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).returns = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // "www2.hm.com" and "faq-us.uniqlo.com" belong to "hm.com" and "uniqlo.com"; "shop.co.uk" keeps three labels.
  function storeDomain(host) {
    const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
    const keep = parts.length > 2 && parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? 3 : 2;
    return parts.slice(-keep).join('.');
  }

  function policyLink(doc, pageUrl) {
    const home = storeDomain(new URL(pageUrl).hostname);
    let best = null;
    let bestScore = 0;
    for (const a of doc.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(a.getAttribute('href'), pageUrl); } catch (_) { continue; }
      if (!/^https?:$/.test(url.protocol) || storeDomain(url.hostname) !== home) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const score = (/\breturns?\b/i.test(text) ? 2 : 0) + (/return/i.test(url.pathname) ? 1 : 0)
        + (/polic|exchange/i.test(text + url.pathname) ? 1 : 0);
      if (score > bestScore) { best = url; bestScore = score; }
    }
    return best && bestScore >= 2 ? best.href : null;
  }

  const DAYS = /(\d{1,3})(?:\s*-\s*\d{1,3})?\s*-?\s*(business\s+|calendar\s+)?days?\b/gi;

  function fromOf(sentence) {
    if (/deliver|receiv|arriv/i.test(sentence)) return 'delivery';
    if (/ship/i.test(sentence)) return 'shipping';
    return 'purchase';
  }

  // -> null | { days, from, sure }
  function readWindow(text) {
    const found = [];
    for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
      if (!/\breturn/i.test(sentence)) continue;
      for (const m of sentence.matchAll(DAYS)) {
        const days = Number(m[1]);
        if (m[2] && /business/i.test(m[2])) continue; // refund timing, not the window
        if (days >= 7 && days <= 365) found.push({ days, from: fromOf(sentence) });
      }
    }
    if (!found.length) return null;
    const sure = found.every((f) => f.days === found[0].days);
    return { days: found[0].days, from: found[0].from, sure };
  }

  return { policyLink, readWindow, storeDomain };
});
