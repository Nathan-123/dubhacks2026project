'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const contract = require('../extension/lib/contract.js');
const score = require('../extension/lib/score.js');
const profile = require('../extension/lib/profile.js');

const source = fs.readFileSync(path.join(__dirname, '../extension/content/content.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const clone = (value) => JSON.parse(JSON.stringify(value));

function product(name = 'A') {
  const p = contract.emptyProduct(`https://store.example/products/${name}`);
  p.identity = { brand: 'Store', name, category: 'top', section: 'men' };
  p.sizes = { system: 'alpha', options: ['S', 'M', 'L'].map((label) => ({ label, available: true, selected: label === 'M' })) };
  p.reviewFit = { aggregate: { scale: 0, label: 'true to size', n: 100 }, n: 100 };
  return p;
}

function usual(label) {
  return profile.apply(profile.emptyProfile(), { type: 'setUsualSize', label, system: 'alpha', category: 'top', section: 'men' });
}

async function page({ settings = { modelConfidence: false }, initialProduct = product(), initialLiveOptions } = {}) {
  const { document } = parseHTML('<html><head><title>Store</title></head><body></body></html>');
  const listeners = {};
  const location = new URL('https://store.example/products/A');
  const requests = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  let storageChanged;
  let callbacks;
  let visible = null;
  let result = { ok: true, product: initialProduct };
  let liveOptions = initialLiveOptions || result.product.sizes.options;
  const renders = [];
  const K = {
    contract, score,
    profile: { ...profile, load: async () => usual('M') },
    extract: {
      extract: async () => clone(result),
      findSizeControl: () => ({ options: liveOptions }),
      jsonLdNodes: () => [], trimmedText: () => '', applyFallbacks: () => {},
    },
    badge: { create: (options) => {
      callbacks = options;
      const host = { isConnected: false };
      return {
        host,
        mount: () => { host.isConnected = true; },
        destroy: () => { host.isConnected = false; visible = null; },
        render: (rec) => { visible = clone(rec); renders.push(visible); },
      };
    } },
  };
  const context = {
    FitKit: K, document, location, structuredClone,
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    chrome: {
      runtime: { sendMessage: (message, callback) => {
        if (message.type === 'getContext') return callback({ config: {}, brandPriors: {}, settings });
        if (['scoreServer', 'modelConfidence'].includes(message.type)) requests.push({ ...message, callback });
        else callback(null);
      } },
      storage: { onChanged: { addListener: (fn) => { storageChanged = fn; } } },
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => {},
  };
  vm.runInNewContext(source, context);
  await flush();
  return {
    requests, renders,
    get visible() { return visible; },
    async advance(ms) {
      const end = clock + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      clock = end;
      await flush();
    },
    async navigate(nextResult, href = 'https://store.example/products/B') {
      result = nextResult;
      location.href = href;
      listeners.popstate();
      await flush();
    },
    async respond(index, rec) { requests[index].callback(rec); await flush(); },
    async changeProfile(value) { storageChanged({ profile: { newValue: value } }, 'local'); await flush(); },
    async select(label, settle = true) {
      liveOptions = product().sizes.options.map((o) => ({ ...o, selected: o.label === label }));
      document.dispatchEvent(new document.defaultView.Event('change'));
      if (settle) await this.advance(120);
    },
    async sellOut(label) {
      liveOptions = liveOptions.map((o) => ({ ...o, available: o.label === label ? false : o.available }));
      document.dispatchEvent(new document.defaultView.Event('change'));
      await flush();
    },
    async retry() { callbacks.onRetry(); await flush(); },
  };
}

test('normal scoring renders the current product verdict', async () => {
  const p = await page();
  assert.equal(p.visible.product.name, 'A');
  assert.equal(p.visible.verdict, score.score(product(), usual('M')).verdict);
});

for (const mode of ['server', 'model']) {
  for (const suffix of ['#reviews', '?utm_source=newsletter', '?variant=2']) {
    test(`${mode} scoring publishes after canonical-equivalent navigation to ${suffix}`, async () => {
      const p = await page({ settings: { serverScoring: mode === 'server', modelConfidence: mode === 'model' } });
      await p.navigate({ ok: true, product: product() }, `https://store.example/products/A${suffix}`);
      assert.equal(p.requests.length, 1, 'same-product navigation must not start replacement scoring');
      await p.respond(0, mode === 'server'
        ? score.score(product(), usual('M'))
        : { ok: true, confidence: 81, reason: 'Current evidence' });
      assert.ok(p.visible, 'the valid response must publish');
      assert.equal(p.visible.product && p.visible.product.name, 'A');
      assert.equal(p.visible.verdict, 'Good buy · M');
      if (mode === 'model') assert.equal(p.visible.confidence, 81);
    });
  }

  test(`${mode} scoring still rejects an old response after a product path change`, async () => {
    const p = await page({ settings: { serverScoring: mode === 'server', modelConfidence: mode === 'model' } });
    await p.navigate({ ok: true, product: product('B') });
    const count = p.renders.length;
    await p.respond(0, mode === 'server'
      ? score.score(product(), usual('M'))
      : { ok: true, confidence: 99, reason: 'Old evidence' });
    assert.equal(p.renders.length, count);
    await p.advance(700);
    await p.respond(1, mode === 'server'
      ? score.score(product('B'), usual('M'))
      : { ok: true, confidence: 81, reason: 'Current evidence' });
    assert.equal(p.visible.product.name, 'B');
    if (mode === 'model') assert.equal(p.visible.confidence, 81);
  });
}

for (const mode of ['local', 'server', 'model']) {
  test(`${mode} scoring uses live selection and availability when extraction initially disagrees`, async () => {
    const initialProduct = product();
    initialProduct.sizes.options.forEach((o) => { o.selected = o.label === 'S'; o.available = o.label !== 'M'; });
    const p = await page({
      initialProduct, initialLiveOptions: product().sizes.options,
      settings: { serverScoring: mode === 'server', modelConfidence: mode === 'model' },
    });
    if (mode === 'server') {
      assert.equal(p.requests[0].product.sizes.options.find((o) => o.selected).label, 'M');
      assert.equal(p.requests[0].product.sizes.options.find((o) => o.label === 'M').available, true);
      await p.respond(0, score.score(p.requests[0].product, usual('M')));
    }
    if (mode === 'model') {
      assert.equal(p.requests.length, 1, 'current evidence must reach model confidence');
      await p.respond(0, { ok: true, confidence: 81, reason: 'Current evidence' });
      assert.equal(p.visible.confidence, 81);
    }
    assert.ok(p.visible, 'initial extraction differences must not suppress the verdict');
    assert.equal(p.visible.selected, 'M');
    assert.equal(p.visible.size, 'M');
  });
}

test('delayed server scoring cannot resurrect a silent page after navigation', async () => {
  const p = await page({ settings: { serverScoring: true, modelConfidence: false } });
  await p.navigate({ silent: true });
  await p.advance(700);
  assert.equal(p.visible, null);
  await p.respond(0, score.score(product(), usual('M')));
  assert.equal(p.visible, null);
});

test('the new product renders normally and an older product cannot overwrite it', async () => {
  const p = await page({ settings: { serverScoring: true, modelConfidence: false } });
  await p.navigate({ ok: true, product: product('B') });
  await p.advance(700);
  await p.respond(1, score.score(product('B'), usual('M')));
  assert.equal(p.visible.product.name, 'B');
  await p.respond(0, score.score(product('A'), usual('M')));
  assert.equal(p.visible.product.name, 'B');
});

test('obsolete server failure cannot show model pending while the next page settles', async () => {
  const p = await page({ settings: { serverScoring: true } });
  await p.navigate({ silent: true });
  const count = p.renders.length;
  await p.respond(0, null);
  assert.equal(p.renders.length, count);
  assert.equal(p.requests.length, 1, 'obsolete work must not request model confidence');
  await p.advance(700);
  assert.equal(p.visible, null);
});

test('delayed model confidence cannot replace an unreadable page verdict', async () => {
  const p = await page({ settings: { modelConfidence: true } });
  await p.navigate({ ok: false, missing: contract.FLOOR, product: null });
  await p.advance(700);
  assert.equal(p.visible.state, 'failed');
  const verdict = p.visible.verdict;
  await p.respond(0, { ok: true, confidence: 95, reason: 'Strong evidence' });
  assert.equal(p.visible.verdict, verdict);
  assert.equal(p.visible.state, 'failed');
});

test('older server scoring cannot overwrite a newer profile verdict', async () => {
  const p = await page({ settings: { serverScoring: true, modelConfidence: false } });
  await p.changeProfile(usual('L'));
  await p.respond(1, score.score(product(), usual('L')));
  assert.equal(p.visible.size, 'L');
  await p.respond(0, score.score(product(), usual('M')));
  assert.equal(p.visible.size, 'L');
});

test('size edits snapshot request inputs and only the latest model result renders', async () => {
  const p = await page({ settings: { modelConfidence: true } });
  await p.select('S');
  await p.respond(1, { ok: true, confidence: 80, reason: 'Current evidence' });
  assert.equal(p.visible.selected, 'S');
  await p.respond(0, { ok: true, confidence: 20, reason: 'Old evidence' });
  assert.equal(p.visible.selected, 'S');
  assert.equal(p.visible.confidence, 80);
});

test('size edits do not mutate an already submitted server product', async () => {
  const p = await page({ settings: { serverScoring: true, modelConfidence: false } });
  await p.select('S');
  assert.equal(p.requests[0].product.sizes.options.find((o) => o.selected).label, 'M');
  await p.respond(1, score.score(p.requests[1].product, usual('M')));
  await p.respond(0, score.score(p.requests[0].product, usual('M')));
  assert.equal(p.visible.selected, 'S');
});

test('a changed size invalidates in-flight scoring before the live-control debounce ends', async () => {
  const p = await page({ settings: { serverScoring: true, modelConfidence: false } });
  await p.select('S', false);
  const count = p.renders.length;
  await p.respond(0, score.score(product(), usual('M')));
  assert.equal(p.renders.length, count);
  await p.advance(120);
  await p.respond(1, score.score(p.requests[1].product, usual('M')));
  assert.equal(p.visible.selected, 'S');
});

test('forced extraction invalidates scoring even on the same URL', async () => {
  const p = await page({ settings: { serverScoring: true, modelConfidence: false } });
  await p.respond(0, score.score(product(), usual('M')));
  await p.changeProfile(usual('S'));
  await p.retry();
  const count = p.renders.length;
  await p.respond(1, score.score(product(), usual('S')));
  assert.equal(p.renders.length, count);
  await p.respond(2, score.score(product(), usual('S')));
  assert.equal(p.visible.size, 'S');
});

test('availability changes block an old model answer before the live-control debounce ends', async () => {
  const p = await page({ settings: { modelConfidence: true } });
  await p.sellOut('M');
  const count = p.renders.length;
  await p.respond(0, { ok: true, confidence: 90, reason: 'Old evidence' });
  assert.equal(p.renders.length, count);
  await p.advance(120);
  await p.respond(1, { ok: true, confidence: 65, reason: 'Current evidence' });
  assert.notEqual(p.visible.size, 'M');
  assert.equal(p.visible.confidence, 65);
});

test('model timeout renders current rules and a late answer cannot replace them', async () => {
  const p = await page({ settings: { modelConfidence: true } });
  await p.advance(3000);
  assert.equal(p.visible.confidence, score.score(product(), usual('M')).confidence);
  assert.equal(p.visible.why.confidenceSource.kind, 'rules');
  const count = p.renders.length;
  await p.respond(0, { ok: true, confidence: 99, reason: 'Too late' });
  assert.equal(p.renders.length, count);
  assert.equal(p.visible.why.confidenceSource.kind, 'rules');
});

test('malformed confidence falls back to the unchanged rule-based verdict', async () => {
  const p = await page({ settings: { modelConfidence: true } });
  await p.respond(0, { ok: false, error: 'bad_model_output' });
  assert.equal(p.visible.confidence, score.score(product(), usual('M')).confidence);
  assert.equal(p.visible.why.confidenceSource.kind, 'rules');
});
