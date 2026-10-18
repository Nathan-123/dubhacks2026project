'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const fixture = JSON.parse(read('fixtures/manifest.json')).cases.find((c) => c.name === 'indie-select');

test('service worker loads and supplies a working browser extraction module chain', async () => {
  let onMessage;
  let injected;
  const event = { addListener() {} };
  const context = vm.createContext({
    URL, URLSearchParams,
    chrome: {
      runtime: { onInstalled: event, onStartup: event, onMessage: { addListener(fn) { onMessage = fn; } } },
      permissions: { onAdded: event, onRemoved: event },
      scripting: { async executeScript({ files }) { injected = files; } },
    },
  });
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(read(`extension/${file}`), context, { filename: file });
  };
  vm.runInContext(read('extension/background.js'), context);
  const response = await new Promise((resolve) => onMessage({ type: 'runOnce', tabId: 1 }, {}, resolve));
  assert.equal(response.ok, true);
  for (const file of injected.filter((file) => file.startsWith('lib/'))) {
    vm.runInContext(read(`extension/${file}`), context, { filename: file });
  }
  const { document } = parseHTML(read(fixture.page));
  const res = await context.FitKit.extract.extract(document, { url: fixture.url });
  assert.equal(res.ok, true);
  assert.equal(res.product.identity.category, 'dress');
  assert.equal(res.product.identity.section, 'women');
  assert.ok(context.FitKit.score.score(res.product, {}).verdict);
});

test('generated probe runs the browser UMD chain on a product fixture', async () => {
  const { document } = parseHTML(read(fixture.page));
  const context = vm.createContext({
    URL, document, location: new URL(fixture.url), performance,
    console: { log() {}, table() {} },
  });
  const report = await vm.runInContext(read('probe/fit-probe.js'), context);
  assert.equal(report.verdict, 'FLOOR OK');
  assert.equal(report.fields['identity.category'], 'dom');
  assert.ok(report.rung0Badge);
});

test('first install opens setup once; updates do not', async () => {
  const installed = [];
  const opened = [];
  const event = { addListener() {} };
  const context = vm.createContext({
    URL, URLSearchParams,
    chrome: {
      runtime: { onInstalled: { addListener(fn) { installed.push(fn); } }, onStartup: event, onMessage: event, getURL: (p) => `chrome-extension://id/${p}` },
      permissions: { onAdded: event, onRemoved: event, getAll: async () => ({ origins: [] }) },
      scripting: { unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
      storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb() } },
      tabs: { create: ({ url }) => { opened.push(url); } },
    },
  });
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(read(`extension/${file}`), context, { filename: file });
  };
  vm.runInContext(read('extension/background.js'), context);
  for (const fn of installed) await fn({ reason: 'update' });
  assert.deepEqual(opened, []);
  for (const fn of installed) await fn({ reason: 'install' });
  assert.deepEqual(opened, ['chrome-extension://id/onboarding/onboarding.html']);
});
