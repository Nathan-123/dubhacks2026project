'use strict';

const P = window.FitKit.profile;
const $ = (id) => document.getElementById(id);
const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));
const getLocal = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const setLocal = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

const params = new URLSearchParams(location.search);
let filter = params.get('category') || 'all';
let pinned = null;
try { pinned = params.get('pin') ? JSON.parse(params.get('pin')) : null; } catch (_) { pinned = null; }
let profile = P.emptyProfile();

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
// render

function renderStrength() {
  const s = P.strength(profile);
  $('strength').textContent = s.score;
  $('strength-bar').style.width = `${s.score}%`;
  $('strength-meter').setAttribute('aria-label', `Profile strength ${s.score} of 100`);
  $('strength-next').textContent = s.next ? `Next: ${s.next}` : 'Strong profile — keep rating orders as they arrive.';
}

function renderFilters() {
  const cats = ['all', ...new Set(profile.wardrobe.map((w) => w.category).filter(Boolean))];
  if (filter !== 'all' && !cats.includes(filter)) cats.push(filter);
  $('filters').innerHTML = cats.map((c) => `<button type="button" data-cat="${esc(c)}" aria-pressed="${c === filter}">${esc(c)}</button>`).join('');
}

function countdown(item) {
  const d = P.daysLeft(item);
  if (d == null) return '';
  if (d < 0) return '<span class="countdown closed">Return window closed</span>';
  return `<span class="countdown ${d <= 7 ? 'soon' : ''}">${d} day${d === 1 ? '' : 's'} left to return</span>`;
}

const FB = [['small', 'Too small'], ['perfect', 'Fit well'], ['large', 'Too big']];

function renderItems() {
  const list = profile.wardrobe
    .filter((w) => filter === 'all' || w.category === filter)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $('empty').hidden = list.length > 0;
  const fmtDate = (d) => { try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { return d; } };
  $('items').innerHTML = list.map((w) => {
    const match = pinned && w.category === pinned.category;
    const meta = [w.category, w.section, fmtDate(w.date), w.source === 'order' ? 'from an order' : w.source === 'manual' ? 'added by you' : w.source, w.price ? `$${w.price}` : null].filter(Boolean);
    return `<li class="item${match ? ' pinned-match' : ''}" data-id="${esc(w.id)}">
      <div class="thumb" aria-label="Size ${esc(w.size)}">${esc(w.size)}</div>
      <div class="title"><span class="brandname">${esc(w.brand)}</span> ${esc(w.name || w.subcategory || w.category || 'Item')}</div>
      <div class="side">
        <div class="seg" role="group" aria-label="Did it fit?">
          ${FB.map(([k, l]) => `<button type="button" data-act="fb" data-fb="${k}" aria-pressed="${w.feedback === k}">${l}</button>`).join('')}
        </div>
        <div class="tools">
          <button type="button" data-act="edit">Edit</button>
          <button type="button" data-act="returned">${w.returned ? 'Mark kept' : 'Returned'}</button>
          <button type="button" data-act="remove">Remove</button>
        </div>
      </div>
      <div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('<span class="sep"></span>')}${countdown(w) ? `<span class="sep"></span>${countdown(w)}` : ''}${w.returned ? '<span class="tag">Returned</span>' : ''}</div>
    </li>`;
  }).join('');
}

function renderPinned() {
  if (!pinned) return;
  $('pinned').hidden = false;
  const same = profile.wardrobe.filter((w) => w.category === pinned.category);
  $('pinned-body').innerHTML = `<div class="pinned-card">
      ${pinned.image ? `<img src="${esc(pinned.image)}" alt="">` : ''}
      <div><b>${esc(pinned.brand)}</b> · ${esc(pinned.name)}<div class="hint">${esc(pinned.category || '')} · ${same.length} similar item${same.length === 1 ? '' : 's'} in your wardrobe, highlighted below</div></div>
    </div>`;
}

function renderStated() {
  const entries = Object.entries(profile.stated || {});
  $('stated').innerHTML = entries.length
    ? entries.map(([k, v]) => { const [sec, cat] = k.split(':'); return `<li><span class="grow"><span class="size-chip">${esc(v.label)}</span><span style="text-transform:capitalize">${esc(cat)}</span> <span class="tag">${esc(sec === 'any' ? 'any section' : sec)}</span></span><button type="button" class="linkish" data-key="${esc(k)}">Remove</button></li>`; }).join('')
    : '<li class="muted">None yet. Tap your size under “What size do you usually buy?” on any product page.</li>';
  $('pref').value = profile.preference || '';
}

async function renderStores() {
  const { stores = {} } = await getLocal('stores');
  let presets = [];
  try { presets = (await (await fetch('../stores.json')).json()).stores || []; } catch (_) { /* none */ }
  const enabled = Object.entries(stores).filter(([, s]) => s.enabled);
  const rows = enabled.map(([h, s]) => `<li>
      <div class="grow">
        <b>${esc(h)}</b> <span class="tag on">On</span>
        <details class="disclosure" style="border:0;padding-top:4px;margin-top:4px"><summary style="font-size:12.5px">Store config</summary>
          <textarea class="store-config" data-host="${esc(h)}" aria-label="Config for ${esc(h)}">${esc(JSON.stringify(s.config || {}, null, 2))}</textarea>
          <button type="button" class="btn sm" data-act="save-config" data-host="${esc(h)}">Save config</button>
        </details>
      </div>
      <button type="button" class="linkish" data-act="remove-store" data-host="${esc(h)}">Turn off</button></li>`);
  const off = presets.filter((p) => !stores[p.host] || !stores[p.host].enabled)
    .map((p) => `<li><span class="grow">${esc(p.name)} <span class="tag">${esc(p.host)}</span></span><button type="button" class="btn sm" data-act="enable-store" data-host="${esc(p.host)}">Turn on</button></li>`);
  $('stores-list').innerHTML = rows.concat(off).join('') || '<li class="muted">No stores yet.</li>';

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
  renderStrength();
  renderFilters();
  renderPinned();
  renderItems();
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
    toast(item.feedback === fb ? 'Feedback cleared' : `Saved — ${item.brand} recommendations updated`);
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

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const item = Object.fromEntries(f.entries());
  if (!window.FitKit.sizes.isSizeLabel(item.size)) { toast('That size format is not recognized'); return; }
  await dispatch({ type: 'addItem', item: { ...item, section: item.section || null, date: item.date || undefined, source: 'manual' } });
  e.target.reset();
  toast('Added');
});

$('anchor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const m = { unit: f.unit };
  for (const k of ['chest', 'pitToPit', 'bodyLength', 'waist', 'inseam']) if (f[k]) m[k] = Number(f[k]);
  await dispatch({ type: 'setAnchor', category: f.category, measurements: m });
  toast('Anchor saved');
});

$('stated').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-key]');
  if (b) await dispatch({ type: 'clearUsualSize', key: b.getAttribute('data-key') });
});

$('pref').addEventListener('change', (e) => dispatch({ type: 'setPreference', preference: e.target.value || null }));

$('stores-list').addEventListener('click', async (e) => {
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
    toast('Config saved');
  }
  renderStores();
});

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

$('seed').addEventListener('click', async () => {
  if (profile.wardrobe.length && !confirm('Replace your current profile with demo data?')) return;
  const seed = await (await fetch('seed.json')).json();
  const today = Date.now();
  const iso = (daysAgo) => new Date(today - daysAgo * 86400000).toISOString().slice(0, 10);
  const next = {
    ...P.emptyProfile(),
    stated: Object.fromEntries(Object.entries(seed.stated).map(([k, v]) => [k, { ...v, at: new Date().toISOString() }])),
    wardrobe: seed.wardrobe.map(({ daysAgo, ...it }) => P.normalizeItem({ ...it, date: iso(daysAgo), feedbackAt: it.feedback ? iso(Math.max(0, daysAgo - 14)) : null })),
  };
  await dispatch({ type: 'replace', profile: next });
  toast('Demo data loaded');
});

// Edits from product tabs (a usual-size tap, an order capture) show up live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.profile) { profile = changes.profile.newValue || P.emptyProfile(); render(); }
  if (changes.stores) renderStores();
});

(async function init() {
  profile = await P.load();
  render();
  renderStores();
})();
