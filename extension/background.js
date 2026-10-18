/*
 * background — the extension's hub: per-store permissions and content-script
 * registration, store configs, the local product cache, and every call to the backend
 * (so pages never talk to localhost directly).
 */
importScripts('lib/sizes.js', 'lib/contract.js', 'lib/score.js', 'lib/profile.js');
const K = self.FitKit;

const CONTENT_FILES = ['lib/sizes.js', 'lib/contract.js', 'lib/score.js', 'lib/extract.js', 'lib/profile.js', 'content/badge.js', 'content/content.js'];
const SCRIPT_ID = 'fitcheck-stores';
const DEFAULT_SETTINGS = { backend: 'http://localhost:8787', serverScoring: false, modelConfidence: true };
const confidenceCache = new Map(); // evidence JSON -> model answer (the server caches too)
const CACHE_KEY = 'productCache';
const CACHE_MAX = 200;
const BACKEND_TIMEOUT_MS = 9000;
const LLM_TIMEOUT_MS = 50000; // a local model on a laptop CPU can take a while; the badge shows pending

// ---------------------------------------------------------------------------
// storage helpers

const getLocal = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const setLocal = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

let presetsPromise = null;
function presets() {
  if (!presetsPromise) presetsPromise = fetch(chrome.runtime.getURL('stores.json')).then((r) => r.json()).catch(() => ({ stores: [], brandPriors: {} }));
  return presetsPromise;
}

async function settings() {
  const { settings: s } = await getLocal('settings');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

const bareHost = (h) => String(h || '').replace(/^www\./, '').toLowerCase();

/** Preset config merged with the user's own edits for this host. */
async function configFor(host) {
  const h = bareHost(host);
  const p = await presets();
  const { stores = {} } = await getLocal('stores');
  const preset = (p.stores || []).find((s) => h === s.host || h.endsWith(`.${s.host}`)) || {};
  const user = (stores[h] && stores[h].config) || {};
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  return { ...clean(preset), ...clean(user) };
}

async function brandPriors() {
  const p = await presets();
  const out = {};
  for (const [k, v] of Object.entries(p.brandPriors || {})) if (typeof v === 'number') out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// stores: permissions -> registered content scripts

async function grantedOrigins() {
  const perms = await chrome.permissions.getAll();
  return (perms.origins || []).filter((o) => !/localhost/.test(o) && o !== 'https://*/*' && o !== 'http://*/*');
}

async function registerAll() {
  const origins = await grantedOrigins();
  try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch (_) { /* not registered */ }
  if (origins.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID, matches: origins, js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: true,
    }]);
  }
  // Keep the stores record in sync with what Chrome actually granted.
  const { stores = {} } = await getLocal('stores');
  const hosts = new Set(origins.map((o) => bareHost(o.replace(/^\w+:\/\//, '').replace(/\/\*$/, ''))));
  for (const h of Object.keys(stores)) stores[h].enabled = hosts.has(h);
  for (const h of hosts) if (!stores[h]) stores[h] = { enabled: true, config: {}, addedAt: new Date().toISOString() };
  await setLocal({ stores });
  return origins;
}

async function injectInto(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }); return true; } catch (e) { return false; }
}

async function injectMatchingTabs(origins) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url) continue;
    let origin;
    try { origin = new URL(t.url).origin; } catch (_) { continue; }
    if (origins.some((o) => o.startsWith(origin))) injectInto(t.id);
  }
}

chrome.runtime.onInstalled.addListener(registerAll);
chrome.runtime.onStartup.addListener(registerAll);
// The popup can close while Chrome's permission prompt is showing, so react here, not there.
chrome.permissions.onAdded.addListener(async (p) => { await registerAll(); if (p.origins) injectMatchingTabs(p.origins); });
chrome.permissions.onRemoved.addListener(registerAll);

// ---------------------------------------------------------------------------
// product cache (offline fallback, keyed by canonical URL)

async function cacheGet(canonical) {
  const { [CACHE_KEY]: cache = {} } = await getLocal(CACHE_KEY);
  return cache[canonical] || null;
}

async function cachePut(product) {
  const canonical = K.contract.canonicalUrl(product.url);
  const { [CACHE_KEY]: cache = {} } = await getLocal(CACHE_KEY);
  cache[canonical] = { product, at: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - CACHE_MAX).forEach((k) => delete cache[k]);
  }
  await setLocal({ [CACHE_KEY]: cache });
}

// ---------------------------------------------------------------------------
// backend

async function backend(path, body, timeoutMs) {
  const { backend: base } = await settings();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || BACKEND_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const j = await r.json().catch(() => null);
    return j || { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'backend unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// messages

const handlers = {
  async getContext({ host }) {
    return { config: await configFor(host), brandPriors: await brandPriors(), settings: await settings() };
  },
  async llmExtract({ payload }) { return backend('/extract-product', payload, LLM_TIMEOUT_MS); },
  async modelConfidence({ evidence }) {
    const k = JSON.stringify(evidence);
    if (confidenceCache.has(k)) return confidenceCache.get(k);
    const r = await backend('/confidence', { evidence }, 8000);
    if (r && r.ok) { confidenceCache.set(k, r); if (confidenceCache.size > 300) confidenceCache.delete(confidenceCache.keys().next().value); }
    return r;
  },
  async scoreServer({ product, profile, opts }) {
    const r = await backend('/score-fit', { product, profile, opts });
    return r && r.recommendation ? r.recommendation : { error: r && r.error };
  },
  async parseOrder({ payload }) { return backend('/parse-order', payload, LLM_TIMEOUT_MS); },
  async cacheGet({ canonical }) { return cacheGet(canonical); },
  async cachePut({ product }) { await cachePut(product); return { ok: true }; },
  async openWardrobe({ category, pin }) {
    const q = new URLSearchParams();
    if (category) q.set('category', category);
    if (pin) q.set('pin', JSON.stringify(pin));
    await chrome.tabs.create({ url: chrome.runtime.getURL(`wardrobe/wardrobe.html?${q}`) });
    return { ok: true };
  },
  async storesChanged() { const origins = await registerAll(); await injectMatchingTabs(origins); return { ok: true, origins }; },
  async runOnce({ tabId }) { return { ok: await injectInto(tabId) }; },
  async clearCache() { await chrome.storage.local.remove(CACHE_KEY); return { ok: true }; },
  async health() { const { backend: base } = await settings(); try { const r = await fetch(`${base}/health`); return await r.json(); } catch (_) { return { ok: false }; } },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  h(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async response
});
