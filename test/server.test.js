'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.OPENROUTER_API_KEY = ''; // tests never call OpenRouter, even if .env has a key
process.env.FIT_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitcheck-cache-'));
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // no local model in these tests; see llm.test.js
const { createServer } = require('../server/index.js');

const jacket = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures/products/af-jacket.json'), 'utf8'));

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try { await fn({ base, post }); } finally { server.close(); }
}

test('GET /health', () => withServer(async ({ base }) => {
  const r = await (await fetch(`${base}/health`)).json();
  assert.equal(r.ok, true);
}));

test('POST /score-fit returns the contract fields', () => withServer(async ({ post }) => {
  const profile = { stated: { 'men:outerwear': { label: 'M', system: 'alpha' } }, wardrobe: [] };
  const r = await post('/score-fit', { product: jacket, profile });
  assert.equal(r.status, 200);
  assert.ok(r.body.best_size);
  assert.equal(typeof r.body.scores_by_size.M, 'number');
  assert.equal(typeof r.body.confidence, 'number');
  assert.ok(r.body.reason);
  assert.ok(r.body.ms < 50);
}));

test('POST /extract-product: complete partial is cached; an unreadable page without the local LLM is an explicit 503', () => withServer(async ({ post }) => {
  const ok = await post('/extract-product', { url: `${jacket.url}?utm_source=x`, partial: jacket });
  assert.equal(ok.status, 200);
  const again = await post('/extract-product', { url: jacket.url });
  assert.equal(again.body.cached, true, 'canonical URL hits the cache');

  const bare = await post('/extract-product', { url: 'https://store.example/p/unknown', text: 'nothing here' });
  assert.equal(bare.status, 503);
  assert.equal(bare.body.error, 'llm_unavailable');
}));

test('POST /parse-order drops anything that looks like PII and normalizes the rest', () => withServer(async ({ post }) => {
  const r = await post('/parse-order', { brand: 'Uniqlo', items: [
    { name: 'Selvedge Slim-Fit Jeans', size: '29', price: 49.9 },
    { name: '123 Main Street', size: 'M' },
    { name: 'Visa ending in 4242', size: 'S' },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].category, 'bottom');
  assert.equal(r.body.items[0].brand, 'Uniqlo');
}));
