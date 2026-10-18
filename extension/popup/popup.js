'use strict';

const $ = (id) => document.getElementById(id);
const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));

function setStatus(el, ok, text, warn) {
  el.innerHTML = `<span class="dot ${ok ? 'ok' : warn ? 'warn' : 'off'}"></span>${text}`;
}

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try { url = new URL(tab.url); } catch (_) { url = null; }

  $('wardrobe').addEventListener('click', () => { send('openWardrobe', {}); window.close(); });

  send('health').then((h) => {
    if (!h || !h.ok) {
      setStatus($('s-backend'), false, 'Offline');
      setStatus($('s-llm'), false, 'Off');
      setStatus($('s-conf'), false, 'Rule-based');
      return;
    }
    setStatus($('s-backend'), true, 'Connected');
    const l = h.llm || {};
    setStatus($('s-llm'), !!l.ok, l.ok ? `${l.provider === 'ollama' ? 'Local' : 'OpenRouter'} · free` : 'Off', !l.ok);
    const c = h.confidence || {};
    setStatus($('s-conf'), !!c.ok, c.ok ? 'OpenRouter · free' : 'Rule-based', !c.ok);
  });

  const status = (state, text) => { $('status').className = `pill ${state}`; $('status-text').textContent = text; };

  if (!url || !/^https?:$/.test(url.protocol)) {
    $('host').textContent = 'No store here';
    $('avatar').textContent = '—';
    status('', 'Open a product page');
    return;
  }
  const host = url.hostname.replace(/^www\./, '');
  const origin = `${url.origin}/*`;
  $('host').textContent = host;
  $('avatar').textContent = host[0];
  const enabled = await chrome.permissions.contains({ origins: [origin] });

  if (enabled) {
    status('ok', 'On for this store');
    $('disable').hidden = false;
    $('note').textContent = 'The badge appears next to the size picker on product pages.';
  } else {
    status('', 'Off for this store');
    $('enable').hidden = false;
    $('once').hidden = false;
  }

  $('enable').addEventListener('click', async () => {
    // Chrome's own one-site prompt. background.js reacts to permissions.onAdded,
    // which still fires if this popup closes while the prompt is open.
    const ok = await chrome.permissions.request({ origins: [origin] });
    if (ok) { await send('storesChanged', {}); window.close(); }
  });
  $('once').addEventListener('click', async () => {
    await send('runOnce', { tabId: tab.id });
    window.close();
  });
  $('disable').addEventListener('click', async () => {
    await chrome.permissions.remove({ origins: [origin] });
    await send('storesChanged', {});
    chrome.tabs.reload(tab.id);
    window.close();
  });
})();
