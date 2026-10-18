'use strict';

/*
 * Store logos. The popup sees the current tab's icon (activeTab grants it, no extra permission) and
 * remembers it per host in chrome.storage.local, so the closet can show the same logo later. The brands
 * setup suggests ship with their own logo (ui/brands/). Anything else without a remembered icon gets
 * its initial instead (.logo.letter in tokens.css).
 */
(function (root) {
  const KEY = 'logos';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const bare = (host) => String(host || '').toLowerCase().replace(/^www\./, '');
  const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function load() {
    return new Promise((resolve) => chrome.storage.local.get(KEY, (r) => resolve(r[KEY] || {})));
  }

  async function remember(host, url) {
    if (!host || !/^https:\/\//.test(url || '')) return;
    const logos = await load();
    if (logos[bare(host)] === url) return;
    await new Promise((resolve) => chrome.storage.local.set({ [KEY]: { ...logos, [bare(host)]: url } }, resolve));
  }

  // Logos shipped with the extension for the setup brands and preset stores; sharper than most tab icons.
  const BUNDLED = {
    uniqlo: 'uniqlo.png', levi: 'levi.png', zara: 'zara.png', hm: 'hm.svg',
    nike: 'nike.png', gap: 'gap.svg', everlane: 'everlane.png', abercrombie: 'abercrombie.png',
    americaneagle: 'americaneagle.png', pacsun: 'pacsun.png',
  };
  // Stores whose website does not start with their name.
  const ALIAS = { 'ae.com': 'americaneagle', 'www2.hm.com': 'hm' };

  // The key whose root matches a host or brand name ("Levi's" and "levi.com" both match "levi").
  function match(keys, hostOrBrand) {
    const want = letters(bare(hostOrBrand).replace(/\.[a-z.]+$/, ''));
    if (!want) return null;
    return keys.find((k) => {
      const root = letters(k.split('.')[0]);
      return root && (want.startsWith(root) || root.startsWith(want));
    }) || null;
  }

  // A host ("uniqlo.com") or a brand name ("Levi's") to a bundled or remembered icon URL, or null.
  function find(logos, hostOrBrand) {
    const bundled = ALIAS[bare(hostOrBrand)] || match(Object.keys(BUNDLED), hostOrBrand);
    if (bundled) return `/ui/brands/${BUNDLED[bundled]}`;
    if (logos[bare(hostOrBrand)]) return logos[bare(hostOrBrand)];
    const host = match(Object.keys(logos), hostOrBrand);
    return host ? logos[host] : null;
  }

  function markup(url, name, size) {
    const cls = `logo${size ? ` ${size}` : ''}`;
    const initial = esc(letters(name).charAt(0) || '?');
    return url
      ? `<span class="${cls}" aria-hidden="true" data-initial="${initial}"><img src="${esc(url)}" alt=""></span>`
      : `<span class="${cls} letter" aria-hidden="true">${initial}</span>`;
  }

  // A remembered icon can stop loading (the site changed it, or we are offline): show the initial instead.
  function guard(container) {
    container.querySelectorAll('.logo img').forEach((img) => img.addEventListener('error', () => {
      const logo = img.parentElement;
      logo.classList.add('letter');
      logo.textContent = logo.dataset.initial;
    }, { once: true }));
  }

  (root.FitKit = root.FitKit || {}).logos = { load, remember, find, markup, guard };
})(typeof self !== 'undefined' ? self : this);
