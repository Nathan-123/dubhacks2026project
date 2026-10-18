/*
 * profile — (event) -> Profile.
 *
 * A pure reducer over profile events plus thin chrome.storage helpers. The profile is
 * the user's data and lives only in chrome.storage.local on their device.
 *
 * Profile shape:
 *   {
 *     version: 1,
 *     stated:   { "<section>:<category>": { label, system, at } },   // rung 1
 *     wardrobe: [ { id, brand, name, category, subcategory, section, size, system,
 *                   price, date, url, image, source, returnBy, feedback, feedbackAt, returned } ],
 *     anchors:  { "<category>": { chest: 21, bodyLength: 28, unit: "in" } },  // optional
 *     preference: null | "fitted" | "regular" | "relaxed"                     // optional
 *   }
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode ? { sizes: require('./sizes.js') } : root.FitKit;
  const mod = factory(deps.sizes);
  if (isNode) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).profile = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sizes) {
  'use strict';

  const STORAGE_KEY = 'profile';
  const RETURN_WINDOW_DAYS = 30;

  function emptyProfile() {
    return { version: 1, stated: {}, wardrobe: [], anchors: {}, preference: null };
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr || Date.now());
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function normalizeItem(item) {
    const p = sizes.parseLabel(item.size);
    const date = item.date || new Date().toISOString().slice(0, 10);
    return {
      id: item.id || uid(),
      brand: item.brand || null,
      name: item.name || null,
      category: item.category || null,
      subcategory: item.subcategory || null,
      section: item.section || null,
      size: item.size || null,
      system: item.system || (p ? p.system : null),
      price: item.price || null,
      date,
      url: item.url || null,
      image: item.image || null,
      source: item.source || 'manual',
      returnBy: item.returnBy || addDays(date, item.returnWindowDays || RETURN_WINDOW_DAYS),
      feedback: item.feedback || null,
      feedbackAt: item.feedbackAt || null,
      returned: !!item.returned,
    };
  }

  /** Pure reducer. Never mutates its input. */
  function apply(profile, event) {
    const p = profile ? JSON.parse(JSON.stringify(profile)) : emptyProfile();
    p.stated = p.stated || {};
    p.wardrobe = p.wardrobe || [];
    p.anchors = p.anchors || {};
    const now = event.at || new Date().toISOString();
    switch (event.type) {
      case 'setUsualSize': {
        const key = `${event.section || 'any'}:${event.category || 'top'}`;
        p.stated[key] = { label: event.label, system: event.system || (sizes.parseLabel(event.label) || {}).system || null, at: now };
        return p;
      }
      case 'clearUsualSize':
        delete p.stated[event.key];
        return p;
      case 'addItem':
        p.wardrobe.push(normalizeItem({ ...event.item, source: event.item.source || 'manual' }));
        return p;
      case 'addItems':
        for (const it of event.items) {
          // Re-visiting an order page must not duplicate items.
          const dup = p.wardrobe.find((w) => w.orderId && w.orderId === it.orderId && w.name === it.name && w.size === it.size);
          if (!dup) p.wardrobe.push({ ...normalizeItem(it), orderId: it.orderId || null });
        }
        return p;
      case 'updateItem': {
        const i = p.wardrobe.findIndex((w) => w.id === event.id);
        if (i >= 0) p.wardrobe[i] = { ...p.wardrobe[i], ...event.patch };
        return p;
      }
      case 'removeItem':
        p.wardrobe = p.wardrobe.filter((w) => w.id !== event.id);
        return p;
      case 'setFeedback': {
        const i = p.wardrobe.findIndex((w) => w.id === event.id);
        if (i >= 0) p.wardrobe[i] = { ...p.wardrobe[i], feedback: event.feedback, feedbackAt: now };
        return p;
      }
      case 'setAnchor':
        p.anchors[event.category] = event.measurements;
        return p;
      case 'setPreference':
        p.preference = event.preference || null;
        return p;
      case 'replace':
        return { ...emptyProfile(), ...event.profile };
      case 'deleteAll':
        return emptyProfile();
      default:
        throw new Error(`Unknown profile event: ${event.type}`);
    }
  }

  /**
   * Profile strength for the confidence meter. Each rung adds visibly, so the meter
   * moves after every input (the pattern promises that; honor it).
   */
  function strength(profile) {
    const p = profile || emptyProfile();
    const stated = Object.keys(p.stated || {}).length;
    const items = (p.wardrobe || []).length;
    const fb = (p.wardrobe || []).filter((w) => w.feedback).length;
    const pts = Math.min(30, stated * 20) + Math.min(30, items * 8) + Math.min(35, fb * 12) + (Object.keys(p.anchors || {}).length ? 5 : 0);
    const next = !stated ? 'Tell us your usual size on any product page'
      : !items ? 'Add an item you own, or check out on an enabled store'
      : !fb ? 'Rate whether a past order fit'
      : null;
    return { score: Math.min(100, pts), stated, items, feedback: fb, next };
  }

  function daysLeft(item, now) {
    if (!item.returnBy) return null;
    const ms = new Date(item.returnBy + 'T23:59:59').getTime() - (now || Date.now());
    return Math.ceil(ms / 86400000);
  }

  // --- storage (browser only) -------------------------------------------------

  function load() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (r) => resolve(r[STORAGE_KEY] || emptyProfile()));
    });
  }

  function save(profile) {
    return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: profile }, () => resolve(profile)));
  }

  async function dispatch(event) {
    const next = apply(await load(), event);
    return save(next);
  }

  return { STORAGE_KEY, emptyProfile, apply, normalizeItem, strength, daysLeft, load, save, dispatch };
});
