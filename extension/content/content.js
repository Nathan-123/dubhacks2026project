/*
 * content — wires extract -> score -> popup on pages the user enabled. It never draws on the page:
 * the popup is the only place a result shows.
 *
 * Runs only on stores the user enabled (registered dynamically by background.js after
 * Chrome's per-site permission prompt), or once on the current tab via activeTab.
 */
(function () {
  'use strict';
  if (window.__fitcheckLoaded) return;
  window.__fitcheckLoaded = true;

  const K = globalThis.FitKit;
  const PENDING_DELAY_MS = 350; // show "Checking fit…" only if extraction is not instant
  const SPA_SETTLE_MS = 700; // wait for a client-rendered product to replace the old one
  const LAZY_REVIEW_TIMEOUT_MS = 2000;
  const MODEL_WAIT_MS = 3000; // longest we hold the first verdict for the confidence model
  const ASK_DISMISS_KEY = 'fitcheck:askDismissed';
  const PREF_DISMISS_KEY = 'fitcheck:prefDismissed';

  const state = {
    ctx: { config: {}, brandPriors: {}, settings: {} },
    profile: null,
    canonical: null,
    product: null,
    stale: false,
    run: 0,
    scoring: 0,
    rec: null,
  };

  // ---------------------------------------------------------------------------
  // messaging

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch (_) { resolve(null); } // extension reloaded underneath us
    });
  }

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return r.ok ? r.json() : null;
  }

  function dismissed(key) {
    try { return sessionStorage.getItem(key) === '1'; } catch (_) { return false; }
  }

  // ---------------------------------------------------------------------------
  // the popup: it shows this page's result as a state of its store card. It asks for the
  // current view when it opens and hears every change while it stays open.

  let view = { status: 'pending' };
  function publish(next) {
    view = next;
    send('fitUpdate', { view });
  }

  function summarize(rec) {
    return { ...K.score.popupView(rec), stale: state.stale };
  }

  async function answerAsk(label) {
    const ask = state.rec && state.rec.ask;
    if (!ask) return;
    const event = ask.type === 'fitPreference'
      ? { type: 'setPreference', preference: ask.values[ask.options.indexOf(label)] }
      : { type: 'setUsualSize', label, system: ask.system, section: ask.section, category: ask.category };
    state.profile = await K.profile.dispatch(event);
    rescore(); // the result changes as a direct result of the tap
  }

  function dismissAsk() {
    const ask = state.rec && state.rec.ask;
    try { sessionStorage.setItem(ask && ask.type === 'fitPreference' ? PREF_DISMISS_KEY : ASK_DISMISS_KEY, '1'); } catch (_) { /* ignore */ }
    rescore();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'fitState') sendResponse({ view });
    else if (msg.type === 'fitAnswer') { answerAsk(msg.label); sendResponse({ ok: true }); }
    else if (msg.type === 'fitDismissAsk') { dismissAsk(); sendResponse({ ok: true }); }
    else if (msg.type === 'fitRetry') { runFor(location.href, { force: true }); sendResponse({ ok: true }); }
    return false;
  });

  function showPending() {
    publish({ status: 'pending' });
  }

  // ---------------------------------------------------------------------------
  // scoring

  async function rescore() {
    const scoring = ++state.scoring;
    if (!state.product) return;
    // Extraction or cache data may already differ from the current size control.
    for (const { option, selected, available } of liveSizeChanges(state.product)) Object.assign(option, { selected, available });
    const run = state.run;
    const canonical = K.contract.canonicalUrl(location.href);
    // Size controls mutate the live Product while backend/model requests are in flight.
    const { product, profile, opts } = structuredClone({
      product: state.product, profile: state.profile,
      opts: { brandPriors: state.ctx.brandPriors, askDismissed: dismissed(ASK_DISMISS_KEY), prefDismissed: dismissed(PREF_DISMISS_KEY) },
    });
    const current = () => scoring === state.scoring && run === state.run && canonical === K.contract.canonicalUrl(location.href) && !liveSizeChanges(product).length;
    let rec = null;
    if (state.ctx.settings && state.ctx.settings.serverScoring) {
      rec = await send('scoreServer', { product, profile, opts });
      if (!current()) return;
    }
    if (!rec || rec.error) {
      rec = K.score.score(product, profile, opts);
      // Model confidence (free OpenRouter model on the backend). Wait briefly, then fall back to
      // the rule-based number, so a verdict is never shown and then flipped. Answers are cached
      // per evidence summary, so size clicks on the same page are instant.
      if (rec.personalized && rec.evidence && state.ctx.settings.modelConfidence !== false) {
        if (!current()) return;
        if (!state.rec) showPending();
        const mc = await Promise.race([send('modelConfidence', { evidence: rec.evidence }), new Promise((r) => setTimeout(() => r(null), MODEL_WAIT_MS))]);
        if (!current()) return;
        if (mc && mc.ok) rec = K.score.score(product, profile, { ...opts, confidenceOverride: mc });
      }
    }
    if (!current()) return;
    state.rec = rec;
    publish({ status: 'done', rec: summarize(rec) });
  }

  // Also read at publication time: a response can arrive before the click debounce ends.
  function liveSizeChanges(product) {
    if (!product || !product.sizes.options) return [];
    const ctl = K.extract.findSizeControl(document, state.ctx.config);
    if (!ctl) return [];
    const changes = [];
    for (const o of product.sizes.options) {
      const live = ctl.options.find((c) => c.label === o.label);
      const selected = !!(live && live.selected);
      const available = live ? live.available !== false : o.available;
      if (selected !== !!o.selected || available !== o.available) changes.push({ option: o, selected, available });
    }
    return changes;
  }

  // The popup opens itself the first time the shopper picks a size on a product: that is when they are
  // deciding, and the answer is ready. Once per product, so trying other sizes stays quiet.
  let offeredFor = null;
  function offerPopup() {
    if (offeredFor === state.canonical) return;
    offeredFor = state.canonical;
    send('openPopup');
  }

  // Re-read the live size control: selection and availability change without navigation.
  function refreshLive() {
    const changes = liveSizeChanges(state.product);
    if (!changes.length) return;
    if (changes.some((c) => c.selected !== !!c.option.selected)) offerPopup();
    rescore();
  }

  let liveTimer = null;
  function scheduleLive() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(refreshLive, 120);
  }
  document.addEventListener('click', scheduleLive, true);
  document.addEventListener('change', scheduleLive, true);

  // ---------------------------------------------------------------------------
  // extraction

  async function loadLazyReviews() {
    const cfg = state.ctx.config || {};
    if (!cfg.lazyReviews) return;
    const region = K.extract.findReviewRegion(document, cfg);
    if (!region || (region.textContent || '').length > 400) return;
    const y = window.scrollY;
    await new Promise((resolve) => {
      const obs = new MutationObserver(() => { if ((region.textContent || '').length > 400) { obs.disconnect(); resolve(); } });
      obs.observe(region, { childList: true, subtree: true, characterData: true });
      region.scrollIntoView({ block: 'center' });
      setTimeout(() => { obs.disconnect(); resolve(); }, LAZY_REVIEW_TIMEOUT_MS);
    });
    window.scrollTo(0, y);
  }

  // Tier 5: shared cache, then the free local LLM on the backend, over trimmed page text.
  async function llmTier(res) {
    const jsonld = K.extract.jsonLdNodes(document).slice(0, 5);
    const out = await send('llmExtract', {
      payload: { url: location.href, text: K.extract.trimmedText(document), jsonld, partial: res.product || null },
    });
    if (!out || !out.ok || !out.product) return null;
    const product = res.product || K.contract.emptyProduct(location.href);
    K.contract.mergeGaps(product, out.product);
    K.extract.applyFallbacks(product);
    return K.contract.missingFloor(product).length ? null : product;
  }

  async function runFor(url, opts) {
    opts = opts || {};
    const canonical = K.contract.canonicalUrl(url);
    if (!opts.force && canonical === state.canonical && state.product) return;
    const run = ++state.run;
    const navigating = state.canonical !== null && state.canonical !== canonical;
    state.canonical = canonical;
    state.product = null;
    state.rec = null;
    state.stale = false;

    // Never show a verdict from the previous product while the new one loads.
    if (navigating) showPending();
    const pendingTimer = setTimeout(() => { if (run === state.run && !state.product) showPending(); }, PENDING_DELAY_MS);
    if (navigating) await new Promise((r) => setTimeout(r, SPA_SETTLE_MS));
    if (run !== state.run) return;

    await loadLazyReviews();
    let res;
    try {
      res = await K.extract.extract(document, { url, config: state.ctx.config, fetchJson });
    } catch (e) {
      res = { ok: false, reason: 'error', missing: K.contract.FLOOR, product: null };
    }
    if (run !== state.run) return;

    if (res.silent) { clearTimeout(pendingTimer); publish({ status: 'none' }); checkOrderPage(); return; }

    let product = res.ok ? res.product : null;
    if (!product) product = await llmTier(res);
    if (run !== state.run) return;

    if (product) {
      send('cachePut', { product });
    } else {
      const cached = await send('cacheGet', { canonical });
      if (run !== state.run) return;
      if (cached && cached.product) { product = cached.product; state.stale = true; }
    }
    clearTimeout(pendingTimer);

    if (!product) {
      const rec = K.score.failed(res.missing || K.contract.FLOOR, res.product);
      state.rec = rec;
      publish({ status: 'failed', rec: summarize(rec) });
      return;
    }
    state.product = product;
    await rescore();
  }

  // ---------------------------------------------------------------------------
  // order confirmation capture (stripped to line items before anything leaves the device)

  const ORDER_URL = /(thank[_-]?you|order[-_]?(confirm|received|complete|success)|checkout\/.*(complete|success|thank)|\/orders?\/[\w-]{4,})/i;
  const ORDER_HEADING = /(thank\s*you\s*for\s*your\s*(order|purchase)|order\s*(is\s*)?confirmed|order\s*confirmation|we('|’)ve\s*received\s*your\s*order)/i;
  const PII = /(@|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b|\b(?:\d[ -]?){13,19}\b|\b\d+\s+\w+\s+(street|st|avenue|ave|road|rd|blvd|lane|ln|drive|dr|way|court|ct)\b|\b(visa|mastercard|amex|ending\s*in|card)\b)/i;

  function scrub(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return PII.test(t) ? null : t.slice(0, 120);
  }

  function orderLineItems() {
    const SIZE_RE = /(?:size|sz)\s*[:\-]?\s*([A-Za-z0-9\/.]{1,7})\b|(?:^|\s)\/\s*([XSML]{1,4}|\d{1,2}(?:x\d{2})?)\s*(?:\/|$)|^([XSML]{1,4}|\d{1,2})\s*\/\s*\w+/i;
    const PRICE_RE = /[$€£]\s?(\d+[.,]\d{2})/;
    const cands = Array.from(document.querySelectorAll('tr, li, [class*="line-item" i], [class*="lineItem"], [class*="product" i], [class*="order-item" i]'))
      .filter((el) => {
        const t = (el.innerText || el.textContent || '');
        return t.length < 400 && SIZE_RE.test(t);
      });
    // Keep innermost matches only.
    const leaves = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    const items = [];
    for (const el of leaves.slice(0, 20)) {
      const lines = (el.innerText || el.textContent || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const joined = lines.join(' \n ');
      const sm = joined.match(SIZE_RE);
      const size = sm && (sm[1] || sm[2] || sm[3]);
      if (!size || !K.sizes.isSizeLabel(size)) continue;
      const name = lines.find((l) => l.length > 3 && !SIZE_RE.test(l) && !PRICE_RE.test(l) && !/^(qty|quantity)/i.test(l)) || lines[0];
      const pm = joined.match(PRICE_RE);
      const clean = { name: scrub(name), size: scrub(size), price: pm ? Number(pm[1].replace(',', '.')) : null };
      if (clean.name && clean.size) items.push(clean);
    }
    return items;
  }

  let orderChecked = false;
  async function checkOrderPage() {
    if (orderChecked) return;
    const heading = Array.from(document.querySelectorAll('h1, h2')).map((h) => h.textContent || '').join(' ');
    if (!ORDER_URL.test(location.pathname) && !ORDER_HEADING.test(heading)) return;
    orderChecked = true;
    const items = orderLineItems();
    if (!items.length) return;
    const om = (document.body.innerText || '').match(/order\s*(?:#|number|no\.?)\s*[:\s]*([A-Z0-9-]{4,})/i);
    const orderId = om ? om[1] : `${location.host}-${new Date().toISOString().slice(0, 10)}`;
    const siteBrand = (document.querySelector('meta[property="og:site_name"]') || {}).content || location.hostname.replace(/^www\./, '').split('.')[0];

    // Optional backend normalization; it only ever sees the scrubbed line items.
    const parsed = await send('parseOrder', { payload: { host: location.hostname, brand: siteBrand, items } });
    const normalized = (parsed && parsed.ok && parsed.items) || items.map((it) => {
      const cat = K.classification.categorize(it.name) || {};
      return { ...it, brand: siteBrand, category: cat.category || null, subcategory: cat.subcategory || null };
    });
    const date = new Date().toISOString().slice(0, 10);
    state.profile = await K.profile.dispatch({
      type: 'addItems',
      items: normalized.map((it) => ({ ...it, brand: it.brand || siteBrand, host: location.hostname.replace(/^www\./, ''), date, orderId, source: 'order' })),
    });
  }

  // ---------------------------------------------------------------------------
  // return policy: read once a month per store from the store's own policy page, so pieces from it count
  // down the real window and cite where it came from. Unclear wording goes to the backend model, which
  // must quote the policy back; without a clear answer nothing is saved.

  const POLICY_KEY = 'returnPolicies';
  const POLICY_MAX_AGE_DAYS = 30;

  async function learnReturnPolicy() {
    const host = location.hostname.replace(/^www\./, '');
    const saved = (await new Promise((r) => chrome.storage.local.get(POLICY_KEY, r)))[POLICY_KEY] || {};
    const old = saved[host];
    if (old && Date.now() - new Date(old.checked).getTime() < POLICY_MAX_AGE_DAYS * 86400000) return;
    const url = K.returns.policyLink(document, location.href);
    if (!url) return;
    const html = await (await fetch(url, { credentials: 'omit' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
    const text = (doc.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
    let found = K.returns.readWindow(text);
    let via = 'page';
    if (!found || !found.sure) {
      const ai = await send('returnPolicy', { text: text.slice(0, 12000) });
      found = ai && ai.ok ? ai : null;
      via = 'ai';
    }
    if (!found) return;
    const name = (document.querySelector('meta[property="og:site_name"]') || {}).content || null;
    saved[host] = { name, days: found.days, from: found.from, url, via, checked: new Date().toISOString() };
    await new Promise((r) => chrome.storage.local.set({ [POLICY_KEY]: saved }, r));
  }

  // ---------------------------------------------------------------------------
  // boot + SPA navigation

  async function boot() {
    state.ctx = (await send('getContext', { host: location.hostname })) || state.ctx;
    state.profile = await K.profile.load();
    await runFor(location.href);
    checkOrderPage();
    learnReturnPolicy().catch(() => { /* no policy found or readable; pieces keep the default window */ });
  }

  // Content scripts cannot patch the page's history.pushState, so watch the URL instead.
  let lastHref = location.href;
  const onMaybeNav = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    orderChecked = false;
    runFor(location.href);
  };
  setInterval(onMaybeNav, 400);
  window.addEventListener('popstate', onMaybeNav);
  new MutationObserver(onMaybeNav).observe(document.querySelector('title') || document.documentElement, { childList: true, subtree: true });

  // Profile edits anywhere (wardrobe tab, another product tab, delete-all) re-score immediately.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[K.profile.STORAGE_KEY]) {
      state.profile = changes[K.profile.STORAGE_KEY].newValue || K.profile.emptyProfile();
      if (!changes[K.profile.STORAGE_KEY].newValue) { try { sessionStorage.removeItem(ASK_DISMISS_KEY); sessionStorage.removeItem(PREF_DISMISS_KEY); } catch (_) { /* ignore */ } }
      rescore();
    }
    if (changes.stores || changes.settings) {
      send('getContext', { host: location.hostname }).then((ctx) => { if (ctx) { state.ctx = ctx; runFor(location.href, { force: true }); } });
    }
  });

  boot();
})();
