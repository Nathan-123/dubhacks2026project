'use strict';

const $ = (id) => document.getElementById(id);
const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));
const L = window.FitKit.logos;
const EASE_SOFT = 'cubic-bezier(.22, 1, .36, 1)';
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const FIT = { fitted: 'Slim fit', regular: 'Regular fit', relaxed: 'Relaxed fit', oversized: 'Oversized fit' };
const SECTION = { men: 'Men’s', women: 'Women’s', both: 'Both sections' };

// The setup answers as pills; Edit reopens setup with them filled in.
function renderFit(profile) {
  const P = window.FitKit.profile;
  const cm = profile.body && profile.body.heightCm;
  const inches = cm ? Math.round(cm / 2.54) : 0;
  const pills = [
    SECTION[profile.section],
    cm ? `${Math.floor(inches / 12)}′${inches % 12}″` : null,
    FIT[profile.preference],
    ...P.anchorItems(profile).map((a) => `${a.brand} ${a.size}`),
  ].filter(Boolean);
  const el = $('fit-pills');
  el.textContent = '';
  $('edit-fit').textContent = pills.length ? 'Edit' : 'Set up';
  if (!pills.length) {
    el.innerHTML = '<span class="empty">Not set up yet. It takes four quick questions.</span>';
    return;
  }
  for (const text of pills) {
    const span = document.createElement('span');
    span.className = 'pill';
    span.textContent = text;
    el.appendChild(span);
  }
}

// Preset stores have a proper name ("Abercrombie & Fitch"); anything else shows its host.
async function storeName(host) {
  try {
    const { stores = [] } = await (await fetch('../stores.json')).json();
    const preset = stores.find((s) => s.host === host);
    if (preset) return preset.name;
  } catch (_) { /* no presets */ }
  return host;
}

// ---------------------------------------------------------------------------
// the store card's result states: checking -> answer (or couldn't read, or not a product page)

// Any change to the card eases its height and lets the new parts settle in, like the setup card.
function morph(change) {
  const sheet = document.querySelector('.sheet');
  const h0 = sheet.offsetHeight;
  change();
  if (reduceMotion()) return;
  const h1 = sheet.offsetHeight;
  if (h0 !== h1) sheet.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 520, easing: EASE_SOFT });
  const parts = [...document.querySelectorAll('#result > :not([hidden]) > :not([hidden])')];
  parts.forEach((el, i) => el.animate(
    [{ opacity: 0, transform: 'translateY(6px)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 480, delay: 60 + i * 50, easing: EASE_SOFT, fill: 'backwards' }));
}

function renderAnswer(rec, failed) {
  const verdict = $('verdict');
  verdict.className = `verdict${failed || !rec.size ? ' none' : rec.state === 'lowConfidence' ? ' guess' : ''}`;
  $('r-size').textContent = failed ? '?' : rec.size || '?';
  $('r-title').textContent = failed ? 'Couldn’t read the sizes here' : rec.title;
  $('r-sub').textContent = failed ? 'Use the store’s own size chart for this one' : rec.sub;
  $('r-reason').textContent = failed ? '' : rec.reason;
  $('r-reason').hidden = failed || !rec.reason;
  $('r-confidence').hidden = failed || !rec.personalized || !rec.confidenceLabel;
  $('r-confidence').textContent = `${rec.confidenceLabel} confidence`;
  $('r-alert').hidden = failed || !rec.alert;
  $('r-alert').textContent = rec.alert ? rec.alert.text : '';
  $('r-ask').hidden = failed || !rec.ask;
  if (rec.ask) {
    $('r-q').textContent = rec.ask.question;
    $('r-opts').innerHTML = '';
    for (const label of rec.ask.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.dataset.label = label;
      b.textContent = label;
      $('r-opts').appendChild(b);
    }
  }
  $('r-retry').hidden = !failed;
}

let shown = null; // the view status on screen, so repeat updates do not replay the transition
function renderView(view) {
  if (!view) return;
  const key = view.status === 'done' || view.status === 'failed' ? JSON.stringify(view) : view.status;
  if (key === shown) return;
  shown = key;
  morph(() => {
    $('result').hidden = view.status === 'none';
    $('checking').hidden = view.status !== 'pending';
    $('answer').hidden = view.status !== 'done' && view.status !== 'failed';
    if (view.status === 'done' || view.status === 'failed') renderAnswer(view.rec || {}, view.status === 'failed');
  });
}

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try { url = new URL(tab.url); } catch (_) { url = null; }

  $('wardrobe').addEventListener('click', () => { send('openWardrobe', {}); window.close(); });
  $('edit-fit').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') }); window.close(); });
  renderFit(await window.FitKit.profile.load());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.profile) renderFit(changes.profile.newValue || window.FitKit.profile.emptyProfile());
  });

  // Shoppers only hear about the service when it is down.
  send('health').then((h) => { $('offline').hidden = !!(h && h.ok); });

  if (!url || !/^https?:$/.test(url.protocol)) {
    $('name').textContent = 'No store on this tab';
    $('logo').innerHTML = L.markup(null, '?');
    $('note').textContent = 'Open a product page on a clothing store to see your size.';
    return;
  }
  const host = url.hostname.replace(/^www\./, '');
  const origin = `${url.origin}/*`;
  const name = await storeName(host);
  $('name').textContent = name;
  $('logo').innerHTML = L.markup(tab.favIconUrl, name);
  L.guard($('logo'));
  L.remember(host, tab.favIconUrl);

  // The page script reports each stage while this popup is open.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'fitUpdate' && sender.tab && sender.tab.id === tab.id) renderView(msg.view);
  });
  const askPage = (type, extra) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type, ...extra }, (res) => resolve(chrome.runtime.lastError ? null : res));
  });

  // One switch per store, like a site setting. Its tooltip says what it does.
  function showState(on) {
    $('toggle-wrap').hidden = false;
    $('toggle').setAttribute('aria-checked', String(on));
    $('site-state').textContent = on ? `On for ${name}. Turn off to stop checking sizes here.` : `Turn on to see your size on ${name}.`;
    if (!on) renderView({ status: 'none' });
  }

  let enabled = await chrome.permissions.contains({ origins: [origin] });
  $('note').textContent = 'Your sizes stay in this browser.';
  showState(enabled);
  const current = enabled ? await askPage('fitState') : null;
  if (current) renderView(current.view);

  $('toggle').addEventListener('click', async () => {
    $('toggle').disabled = true;
    if (!enabled) {
      // Chrome's own one-site prompt. background.js reacts to permissions.onAdded,
      // which still fires if this popup closes while the prompt is open.
      enabled = await chrome.permissions.request({ origins: [origin] });
      showState(enabled);
      if (enabled) {
        const already = await askPage('fitState');
        await send('storesChanged', {});
        renderView(already ? already.view : { status: 'pending' });
      }
    } else {
      await chrome.permissions.remove({ origins: [origin] });
      await send('storesChanged', {});
      enabled = false;
      showState(false);
      // The page script cannot be unloaded; a reload makes off really off.
      chrome.tabs.reload(tab.id);
    }
    $('toggle').disabled = false;
  });
  $('r-opts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-label]');
    if (!b) return;
    b.setAttribute('aria-pressed', 'true');
    askPage('fitAnswer', { label: b.dataset.label });
  });
  $('r-skip').addEventListener('click', () => askPage('fitDismissAsk'));
  $('r-retry').addEventListener('click', async () => {
    renderView({ status: 'pending' });
    // No page script to retry (it never loaded): try loading it once more.
    if (!(await askPage('fitRetry'))) {
      const res = await send('runOnce', { tabId: tab.id });
      if (!res || !res.ok) renderView({ status: 'failed', rec: {} });
    }
  });
})();
