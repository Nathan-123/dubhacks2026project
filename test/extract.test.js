'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');

const contract = require('../extension/lib/contract.js');
const extract = require('../extension/lib/extract.js');
const { runCase } = require('../scripts/extract-fixture.js');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/manifest.json'), 'utf8'));

/** Every key in `expected` must match in `actual`; arrays match element-wise by position. */
function assertSubset(actual, expected, where) {
  if (expected === null || typeof expected !== 'object') {
    assert.deepEqual(actual, expected, `${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return;
  }
  assert.ok(actual != null, `${where}: missing`);
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${where}: length`);
    expected.forEach((e, i) => assertSubset(actual[i], e, `${where}[${i}]`));
    return;
  }
  for (const k of Object.keys(expected)) assertSubset(actual[k], expected[k], `${where}.${k}`);
}

for (const c of manifest.cases) {
  test(`fixture ${c.name} matches expected extraction`, async () => {
    const res = await runCase(c);
    const expected = JSON.parse(fs.readFileSync(path.join(ROOT, c.expected), 'utf8'));
    assertSubset(res, expected, c.name);
  });

  test(`fixture ${c.name}: every filled field has provenance`, async () => {
    const res = await runCase(c);
    if (!res.product) return; // silent pages produce no Product at all
    assert.deepEqual(contract.unsourced(res.product), [], 'filled fields without _src');
  });
}

test('an empty extraction is an explicit failure, never an empty Product', async () => {
  const { document } = parseHTML('<!doctype html><html><head><meta property="og:type" content="product"></head><body></body></html>');
  const res = await extract.extract(document, { url: 'https://x.example/p/1' });
  assert.equal(res.ok, false);
  assert.ok(res.missing.includes('sizes.options'));
});

test('a stronger tier is never overwritten by a weaker one', () => {
  const p = contract.emptyProduct('https://x.example/p');
  contract.fill(p, 'identity.brand', 'FromShopify', 'shopifyJson');
  contract.fill(p, 'identity.brand', 'FromDom', 'dom');
  assert.equal(p.identity.brand, 'FromShopify');
  assert.equal(p._src['identity.brand'], 'shopifyJson');
});

test('canonical URL strips tracking params, hash, www and trailing slash', () => {
  assert.equal(contract.canonicalUrl('https://www.store.com/products/tee/?utm_source=x&variant=2#reviews'), 'https://store.com/products/tee');
});

test('garment vs body charts are told apart, unknown when unclear', () => {
  const { parseChartTable } = extract._internal;
  const mk = (caption) => parseHTML(`<div><p>${caption}</p><table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>36</td></tr><tr><td>M</td><td>38-40</td></tr></table></div>`).document.querySelector('table');
  assert.equal(parseChartTable(mk('Garment measurements, laid flat')).kind, 'garment');
  assert.equal(parseChartTable(mk('Body measurements: to fit chest')).kind, 'body');
  assert.equal(parseChartTable(mk('Size guide')).kind, 'unknown');
  assert.equal(parseChartTable(mk('Size guide')).rows[1].chest, 39);
});

test('review text is never stored, only computed facts', async () => {
  const c = manifest.cases.find((x) => x.name === 'shopify-tee');
  const res = await runCase(c);
  assert.ok(!JSON.stringify(res.product).includes('Loved the fabric'));
});
