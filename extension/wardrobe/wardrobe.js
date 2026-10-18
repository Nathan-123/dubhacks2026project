'use strict';

const P = window.FitKit.profile;
const L = window.FitKit.logos;
const $ = (id) => document.getElementById(id);
const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));
const getLocal = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const setLocal = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

const params = new URLSearchParams(location.search);
let filter = params.get('category') || 'all';
let pinned = null;
try { pinned = params.get('pin') ? JSON.parse(params.get('pin')) : null; } catch (_) { pinned = null; }
let profile = P.emptyProfile();
let logos = {};
const prefMenu = window.FitKit.select.enhance($('pref'));
let presets = []; // stores.json: names, and curated return windows for the closet's countdowns
let learned = {}; // return windows read from stores' own policy pages (content.js), by host
// Policies for the countdowns: what a store's own page says first, then the curated list.
const policies = () => [
  ...Object.entries(learned).map(([host, p]) => ({
    host, name: (presets.find((s) => s.host === host) || {}).name || p.name || host, returns: { days: p.days, url: p.url },
  })),
  ...presets,
];
const loadPresets = async () => { try { return (await (await fetch('../stores.json')).json()).stores || []; } catch (_) { return []; } };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function dispatch(event) {
  profile = await P.dispatch(event);
  render();
}

// ---------------------------------------------------------------------------
// section links: the one for the section in view is marked current. Sizes and Stores share a row,
// so "in view" is the last section whose top has passed the header, and the page bottom means the last link.

let clicked = null; // the link last clicked wins until the page has reached its section and moved on
let arrived = false;
function markSection() {
  const links = [...document.querySelectorAll('.tabs a')];
  const top = (a) => { const s = document.querySelector(a.hash); return s && !s.hidden ? s.getBoundingClientRect().top : Infinity; };
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  if (clicked) {
    const here = atBottom || (top(clicked) > -8 && top(clicked) <= 120);
    if (here) arrived = true;
    else if (arrived) clicked = null;
  }
  const current = clicked || (atBottom ? links.at(-1) : links.filter((a) => top(a) <= 120).at(-1) || links[0]);
  links.forEach((a) => a.setAttribute('aria-current', String(a === current)));
}
window.addEventListener('scroll', markSection, { passive: true });
document.querySelector('.tabs').addEventListener('click', (e) => {
  clicked = e.target.closest('a');
  arrived = false;
  if (clicked) document.querySelectorAll('.tabs a').forEach((l) => l.setAttribute('aria-current', String(l === clicked)));
});
markSection();

// ---------------------------------------------------------------------------
// render

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const SECTION = { men: 'Men’s', women: 'Women’s', unisex: 'Unisex', both: 'Both sections' };
const FIT = { fitted: 'Slim fit', regular: 'Regular fit', relaxed: 'Relaxed fit', oversized: 'Oversized fit' };
const FB = [['small', 'Too small'], ['perfect', 'Just right'], ['large', 'Too big']];
const FB_NOTE = { perfect: ['Fits you', 'fits'], small: ['Ran small', ''], large: ['Ran big', ''] };

function fmtDate(d) {
  try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { return d; }
}

const KIND = { top: 'Tops', bottom: 'Bottoms', outerwear: 'Jackets', dress: 'Dresses', shoes: 'Shoes', other: 'Other' };
const fmtSize = (s) => window.FitKit.sizes.spelledOut(s);
// Long closets show this many brands or pieces, then a Show all button.
const FIRST = 6;
const showAll = { brands: false, items: false };
const moreButton = (key, n, noun) => n > FIRST && !showAll[key]
  ? `<li class="more"><button type="button" class="btn sm" data-more="${key}">Show all ${n} ${noun}</button></li>` : '';

// One card per brand with a row per kind of piece: a brand's jeans, tops and jackets size differently.
function renderBrands() {
  const brands = P.brandSizes(profile);
  $('passport').hidden = brands.length === 0;
  $('brands').innerHTML = brands.slice(0, showAll.brands ? undefined : FIRST).map(({ brand, pieces }) => `<li class="brand">
      <div class="brand-head">${L.markup(L.find(logos, brand), brand)}<b>${esc(brand)}</b></div>
      <ul class="brand-pieces">${pieces.map((p) => {
        const [note, cls] = FB_NOTE[p.feedback] || ['Not rated yet', ''];
        return `<li><span class="kind">${esc(KIND[p.kind] || cap(p.kind))}<span class="note ${cls}">${esc(note)}</span></span>
          <span class="size">${esc(fmtSize(p.size))}</span></li>`;
      }).join('')}</ul></li>`).join('') + moreButton('brands', brands.length, 'brands');
  L.guard($('brands'));
}

function renderFilters() {
  const cats = ['all', ...new Set(profile.wardrobe.map((w) => w.category).filter(Boolean))];
  if (filter !== 'all' && !cats.includes(filter)) cats.push(filter);
  $('filters').hidden = cats.length < 3;
  $('filters').innerHTML = cats.map((c) => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === filter}">${esc(c === 'all' ? 'All' : cap(c))}</button>`).join('');
}

// "20 days left to return · Uniqlo policy", linking the store's own policy when it is curated.
function countdown(item) {
  const r = P.returnWindow(item, policies());
  if (!r) return '';
  const d = r.daysLeft;
  const text = d < 0 ? 'Return window closed' : d === 0 ? 'Last day to return' : `${d} day${d === 1 ? '' : 's'} left to return`;
  const source = r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.store)} policy</a>` : '';
  return `<span class="countdown ${d >= 0 && d <= 7 ? 'soon' : ''}">${text}${source}</span>`;
}

function renderItems() {
  const list = profile.wardrobe
    .filter((w) => filter === 'all' || w.category === filter)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $('empty').hidden = list.length > 0;
  $('items').hidden = list.length === 0;
  $('items').innerHTML = list.slice(0, showAll.items ? undefined : FIRST).map((w) => {
    const match = pinned && w.category === pinned.category;
    const what = [w.name || cap(w.subcategory || w.category) || 'Item', SECTION[w.section]].filter(Boolean).join(', ');
    const meta = [
      w.date ? `Bought ${fmtDate(w.date)}` : null,
      w.source === 'order' ? 'From an order' : w.source === 'onboarding' ? 'From setup' : null,
      w.price ? `$${Number(w.price).toFixed(2)}` : null,
    ].filter(Boolean);
    return `<li class="item${match ? ' pinned-match' : ''}${w.returned ? ' returned' : ''}" data-id="${esc(w.id)}">
      <div class="item-top">${L.markup(L.find(logos, w.brand), w.brand)}
        <div><b>${esc(w.brand)}</b><span class="what">${esc(what)}</span></div>
        <span class="size" aria-label="Size ${esc(w.size)}">${esc(fmtSize(w.size))}</span></div>
      ${meta.length || countdown(w) || w.returned ? `<div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}${countdown(w)}${w.returned ? '<span class="pill">Returned</span>' : ''}</div>` : ''}
      <div class="fit-q"><span>How did it fit?</span>
        <div class="choices sm" role="group" aria-label="How did it fit?">
          ${FB.map(([k, l]) => `<button type="button" class="choice" data-act="fb" data-fb="${k}" aria-pressed="${w.feedback === k}">${l}</button>`).join('')}
        </div></div>
      <div class="tools">
        <button type="button" class="btn ghost sm" data-act="edit">Edit</button>
        <button type="button" class="btn ghost sm" data-act="returned">${w.returned ? 'I kept it' : 'I returned it'}</button>
        <button type="button" class="btn ghost sm" data-act="remove">Remove</button>
      </div>
    </li>`;
  }).join('') + moreButton('items', list.length, 'pieces');
  L.guard($('items'));
}

function renderPinned() {
  if (!pinned) return;
  $('pinned').hidden = false;
  const same = profile.wardrobe.filter((w) => w.category === pinned.category);
  $('pinned-body').innerHTML = `<div class="pinned-card">
      ${pinned.image ? `<img src="${esc(pinned.image)}" alt="">` : ''}
      <div><b>${esc(pinned.brand)}</b> ${esc(pinned.name)}<p class="hint">${same.length} similar piece${same.length === 1 ? '' : 's'} in your closet, outlined below.</p></div>
    </div>`;
}

// Setup answers as read-only pills, the same ones the popup shows.
function renderAnswers() {
  const a = P.anchorItem(profile);
  const cm = profile.body && profile.body.heightCm;
  const inches = cm ? Math.round(cm / 2.54) : 0;
  const pills = [
    SECTION[profile.section],
    cm ? `${Math.floor(inches / 12)}′${inches % 12}″` : null,
    FIT[profile.preference],
    a ? `Best fit: ${a.brand} ${a.size}` : null,
  ].filter(Boolean);
  $('setup-answers').innerHTML = pills.map((t) => `<span class="pill">${esc(t)}</span>`).join('');
  $('edit-setup').textContent = pills.length ? 'Edit setup' : 'Set up';
}

function renderStated() {
  const entries = Object.entries(profile.stated || {});
  $('stated').innerHTML = entries.length
    ? entries.map(([k, v]) => { const [sec, cat] = k.split(':'); return `<li><span class="grow stated-row"><span>${esc(cap(cat))}${sec === 'any' ? '' : `, ${esc(SECTION[sec] || sec)}`}</span><b class="stated-size">${esc(v.label)}</b></span><button type="button" class="btn ghost sm" data-key="${esc(k)}">Remove</button></li>`; }).join('')
    : '<li class="muted">On any product page, tap your size under “What size do you usually buy?” and it’s saved here.</li>';
  $('pref').value = profile.preference || '';
  prefMenu.refresh();
}

async function renderStores() {
  const { stores = {} } = await getLocal('stores');
  const nameOf = (h) => (presets.find((p) => p.host === h) || {}).name || h;
  // The same on/off switch as the popup.
  const row = (h, on) => `<li>${L.markup(L.find(logos, h), nameOf(h), 'sm')}
      <span class="grow"><span class="name">${esc(nameOf(h))}</span>${nameOf(h) !== h ? `<span class="host">${esc(h)}</span>` : ''}</span>
      <button type="button" class="toggle" role="switch" aria-checked="${on}" aria-label="Fitting Room on ${esc(nameOf(h))}"
        data-act="${on ? 'remove-store' : 'enable-store'}" data-host="${esc(h)}"></button></li>`;
  const enabled = Object.entries(stores).filter(([, s]) => s.enabled).map(([h]) => h);
  const off = presets.map((p) => p.host).filter((h) => !enabled.includes(h));
  $('stores-list').innerHTML = enabled.map((h) => row(h, true)).concat(off.map((h) => row(h, false))).join('') || '<li class="muted">No stores yet.</li>';
  L.guard($('stores-list'));

  // Per-store page setup is for tuning, so it lives under Advanced.
  $('store-configs').innerHTML = enabled.map((h) => `<li><div class="grow" style="display:grid;gap:6px">
      <span class="name">${esc(nameOf(h))} page setup</span>
      <textarea class="store-config" data-host="${esc(h)}" aria-label="Page setup for ${esc(h)}">${esc(JSON.stringify(stores[h].config || {}, null, 2))}</textarea>
      <span><button type="button" class="btn sm" data-act="save-config" data-host="${esc(h)}">Save</button></span></div></li>`).join('');

  const { settings = {} } = await getLocal('settings');
  $('server-scoring').checked = !!settings.serverScoring;
  $('model-confidence').checked = settings.modelConfidence !== false;
  $('backend-url').value = settings.backend || 'http://localhost:8787';
  send('health').then((h) => {
    if (!h || !h.ok) { $('backend-status').textContent = 'Backend offline. On-device reading and saved pages still work; confidence is rule-based.'; return; }
    const l = h.llm || {}; const c = h.confidence || {};
    $('backend-status').textContent = `Backend connected. Page reader: ${l.ok ? `${l.model} via ${l.provider} (free)` : `off (${l.reason || 'not configured'})`}. Confidence: ${c.ok ? `${c.model} via OpenRouter (free)` : `rule-based (${c.reason || 'no key'})`}.`;
  });
}

function render() {
  renderBrands();
  renderFilters();
  renderPinned();
  renderItems();
  renderAnswers();
  renderStated();
}

// ---------------------------------------------------------------------------
// events

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  filter = b.getAttribute('data-cat');
  render();
});

document.addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (!more) return;
  showAll[more.dataset.more] = true;
  render();
});

$('items').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const li = e.target.closest('[data-id]');
  if (!btn || !li) return;
  const id = li.getAttribute('data-id');
  const item = profile.wardrobe.find((w) => w.id === id);
  const act = btn.getAttribute('data-act');
  if (act === 'fb') {
    const fb = btn.getAttribute('data-fb');
    await dispatch({ type: 'setFeedback', id, feedback: item.feedback === fb ? null : fb });
    toast(item.feedback === fb ? 'Cleared' : `Saved. Your ${item.brand} sizes are updated.`);
  } else if (act === 'remove') {
    await dispatch({ type: 'removeItem', id });
    toast('Removed');
  } else if (act === 'returned') {
    await dispatch({ type: 'updateItem', id, patch: { returned: !item.returned } });
  } else if (act === 'edit') {
    const size = prompt(`Size for ${item.brand} ${item.name || ''}`, item.size);
    if (size === null) return;
    const category = prompt('Category (top, bottom, outerwear, dress, shoes)', item.category || 'top');
    if (category === null) return;
    const sys = (window.FitKit.sizes.parseLabel(size) || {}).system || null;
    await dispatch({ type: 'updateItem', id, patch: { size: size.trim(), system: sys, category: category.trim() || null } });
  }
});

function showAddForm(open) {
  $('add-form').hidden = !open;
  $('add-open').setAttribute('aria-expanded', String(open));
  if (open) $('add-form').querySelector('input').focus();
}
$('add-open').addEventListener('click', () => showAddForm($('add-form').hidden));
$('add-cancel').addEventListener('click', () => { showAddForm(false); $('add-open').focus(); });
$('edit-setup').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') }));

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const item = Object.fromEntries(f.entries());
  if (!window.FitKit.sizes.isSizeLabel(item.size)) { toast('That size format is not recognized'); return; }
  await dispatch({ type: 'addItem', item: { ...item, section: item.section || null, date: item.date || undefined, source: 'manual' } });
  e.target.reset();
  showAddForm(false);
  toast('Added to your closet');
});

$('stated').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-key]');
  if (b) await dispatch({ type: 'clearUsualSize', key: b.getAttribute('data-key') });
});

$('pref').addEventListener('change', (e) => dispatch({ type: 'setPreference', preference: e.target.value || null }));

async function onStoreAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const host = b.getAttribute('data-host');
  const act = b.getAttribute('data-act');
  if (act === 'enable-store') {
    const ok = await chrome.permissions.request({ origins: [`https://${host}/*`, `https://www.${host}/*`] });
    if (ok) { await send('storesChanged', {}); toast(`${host} enabled`); }
  } else if (act === 'remove-store') {
    try { await chrome.permissions.remove({ origins: [`https://${host}/*`, `https://www.${host}/*`, `http://${host}/*`] }); } catch (_) { /* some were never granted */ }
    await send('storesChanged', {});
    toast(`${host} turned off`);
  } else if (act === 'save-config') {
    const ta = document.querySelector(`textarea[data-host="${CSS.escape(host)}"]`);
    let config;
    try { config = JSON.parse(ta.value || '{}'); } catch (_) { toast('Config is not valid JSON'); return; }
    const { stores = {} } = await getLocal('stores');
    stores[host] = { ...(stores[host] || { enabled: true }), config };
    await setLocal({ stores });
    toast('Page setup saved');
  }
  renderStores();
}
$('stores-list').addEventListener('click', onStoreAction);
$('store-configs').addEventListener('click', onStoreAction);

// Add-a-store: one permission prompt, then the same pipeline with an empty config.
$('store-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let u;
  try { u = new URL(/^https?:\/\//.test($('store-url').value) ? $('store-url').value : `https://${$('store-url').value}`); } catch (_) { toast('Enter a store URL'); return; }
  const host = u.hostname.replace(/^www\./, '');
  const ok = await chrome.permissions.request({ origins: [`https://${host}/*`, `https://www.${host}/*`] });
  if (!ok) return;
  const { stores = {} } = await getLocal('stores');
  stores[host] = { enabled: true, config: (stores[host] && stores[host].config) || {}, addedAt: new Date().toISOString() };
  await setLocal({ stores });
  await send('storesChanged', {});
  $('store-url').value = '';
  toast(`${host} enabled`);
  renderStores();
});

$('model-confidence').addEventListener('change', async (e) => {
  const { settings = {} } = await getLocal('settings');
  await setLocal({ settings: { ...settings, modelConfidence: e.target.checked } });
});
$('server-scoring').addEventListener('change', async (e) => {
  const { settings = {} } = await getLocal('settings');
  await setLocal({ settings: { ...settings, serverScoring: e.target.checked } });
});
$('backend-url').addEventListener('change', async (e) => {
  const { settings = {} } = await getLocal('settings');
  await setLocal({ settings: { ...settings, backend: e.target.value.replace(/\/+$/, '') } });
  renderStores();
});

$('delete-all').addEventListener('click', async () => {
  if (!confirm('Delete your wardrobe, sizes, cached pages and store list from this device? This cannot be undone.')) return;
  const { stores = {} } = await getLocal('stores');
  const origins = Object.keys(stores).flatMap((h) => [`https://${h}/*`, `https://www.${h}/*`, `http://${h}/*`]);
  if (origins.length) { try { await chrome.permissions.remove({ origins }); } catch (_) { /* some not granted */ } }
  await new Promise((r) => chrome.storage.local.clear(r));
  await send('storesChanged', {});
  profile = P.emptyProfile();
  logos = {};
  render();
  renderStores();
  toast('Everything deleted');
});

$('export').addEventListener('click', async () => {
  const data = await getLocal(null);
  const blob = new Blob([JSON.stringify({ profile: data.profile, stores: data.stores, settings: data.settings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fitcheck-data.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

// Edits from product tabs (a usual-size tap, an order capture) show up live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.profile) { profile = changes.profile.newValue || P.emptyProfile(); render(); }
  if (changes.stores) renderStores();
  if (changes.logos) { logos = changes.logos.newValue || {}; render(); renderStores(); }
  if (changes.returnPolicies) { learned = changes.returnPolicies.newValue || {}; render(); }
});

(async function init() {
  [profile, logos, presets, { returnPolicies: learned = {} }] = await Promise.all([P.load(), L.load(), loadPresets(), getLocal('returnPolicies')]);
  render();
  renderStores();
})();
