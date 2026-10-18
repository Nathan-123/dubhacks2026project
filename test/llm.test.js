'use strict';

// Exercises the free local LLM tier against a stand-in Ollama server, so it runs anywhere
// (including CI) without a model installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.OPENROUTER_API_KEY = ''; // tests never call OpenRouter, even if .env has a key
process.env.FIT_LLM_PROVIDER = 'ollama';
process.env.FIT_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitting-room-llm-cache-'));
const llm = require('../server/llm.js');
const contract = require('../extension/lib/contract.js');
const { createServer } = require('../server/index.js');

const PAGE_TEXT = 'Field Jacket by Ridgeline. Sizes: S M L XL. XL sold out. 100% cotton. Reviews: 70% say runs small, 25% true to size, 5% runs large. Based on 40 reviews.';

// What a small model might return, including things that are NOT on the page.
const MODEL_REPLY = {
  brand: 'Ridgeline', name: 'Field Jacket', category: 'outerwear', section: null, cutHint: null,
  sizes: [{ label: 'S', available: true }, { label: 'M', available: true }, { label: 'L', available: true }, { label: 'XL', available: false }, { label: 'XXL', available: true }],
  sizeChart: { kind: 'unknown', unit: null, rows: [] },
  fabric: { composition: [{ material: 'cotton', pct: 100 }, { material: 'elastane', pct: 3 }], stretch: false },
  modelRef: { heightCm: null, sizeWorn: null },
  reviewFit: { label: 'runs small', pctRunsSmall: 0.7, pctTrueToSize: 0.25, pctRunsLarge: 0.05, n: 40 },
};

function startFakeOllama({ hasModel = true } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: hasModel ? [{ name: llm.MODEL }] : [] }));
      if (req.url === '/api/chat') {
        const j = JSON.parse(body);
        calls.push(j);
        const isOrder = /label clothing order/.test(j.messages[0].content);
        const reply = isOrder ? { items: [{ name: 'Slim Jeans', brand: 'Uniqlo', category: 'bottom', subcategory: 'jeans' }] } : MODEL_REPLY;
        return res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(reply) } }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, () => {
    process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, calls });
  }));
}

test('the LLM tier calls the local Ollama API with a JSON schema and temperature 0', async () => {
  const { server, calls } = await startFakeOllama();
  try {
    await llm.extractProduct({ url: 'https://ridgeline.example/p/field-jacket', text: PAGE_TEXT, jsonld: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, llm.MODEL);
    assert.equal(calls[0].stream, false);
    assert.equal(calls[0].options.temperature, 0);
    assert.equal(calls[0].format.type, 'object');
  } finally { server.close(); }
});

test('hallucination guard: keeps only facts that appear in the page text', async () => {
  const { server } = await startFakeOllama();
  try {
    const p = await llm.extractProduct({ url: 'https://ridgeline.example/p/field-jacket', text: PAGE_TEXT, jsonld: [] });
    assert.deepEqual(p.sizes.options.map((o) => o.label), ['S', 'M', 'L', 'XL'], 'invented XXL dropped');
    assert.equal(p.sizes.options.find((o) => o.label === 'XL').available, false);
    assert.deepEqual(p.fabric.composition.map((c) => c.material), ['cotton'], 'invented elastane dropped');
    assert.equal(p.reviewFit.distribution.runsSmall, 0.7);
    assert.equal(p._src['sizes.options'], 'llm');
    assert.deepEqual(contract.unsourced(p), []);
  } finally { server.close(); }
});

test('/extract-product fills gaps with the local LLM and never overwrites on-device fields', async () => {
  const { server } = await startFakeOllama();
  const app = createServer();
  await new Promise((r) => app.listen(0, r));
  try {
    const partial = contract.emptyProduct('https://ridgeline.example/p/field-jacket');
    contract.fill(partial, 'identity.name', 'Field Jacket (on-device)', 'dom');
    const r = await fetch(`http://127.0.0.1:${app.address().port}/extract-product`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: partial.url, text: PAGE_TEXT, jsonld: [], partial }),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.product.identity.name, 'Field Jacket (on-device)');
    assert.equal(body.product._src['identity.name'], 'dom');
    assert.equal(body.product._src['sizes.options'], 'llm');
    assert.equal(contract.extractionQuality(body.product), 'llm');
  } finally { server.close(); app.close(); }
});

test('/parse-order: the LLM labels brand/category but size and price stay from the page', async () => {
  const { server } = await startFakeOllama();
  const app = createServer();
  await new Promise((r) => app.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${app.address().port}/parse-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Uniqlo', items: [{ name: 'Slim Jeans', size: '29', price: 49.9 }] }),
    });
    const body = await r.json();
    assert.equal(body.via, 'llm');
    assert.equal(body.items[0].size, '29');
    assert.equal(body.items[0].price, 49.9);
    assert.equal(body.items[0].subcategory, 'jeans');
  } finally { server.close(); app.close(); }
});

test('status reports a missing model with the pull command', async () => {
  const { server } = await startFakeOllama({ hasModel: false });
  try {
    const s = await llm.status();
    assert.equal(s.ok, false);
    assert.match(s.reason, /ollama pull/);
  } finally { server.close(); }
});

test('Ollama not running: explicit 503, nothing breaks', async () => {
  process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // nothing listens here
  const app = createServer();
  await new Promise((r) => app.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${app.address().port}/extract-product`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.example/p/unknown', text: 'x' }),
    });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'llm_unavailable');
    assert.equal((await llm.status()).ok, false);
  } finally { app.close(); }
});

test('a model return window is kept only when its quote is really in the policy and names that number', () => {
  const { checkReturns } = require('../server/llm.js');
  const text = 'Returns are free in store.  Online returns must be postmarked within 30 days of the delivery date.';
  const quote = 'Online returns must be postmarked within 30 days of the delivery date.';
  assert.deepEqual(checkReturns(text, { days: 30, from: 'delivery', quote }), { days: 30, from: 'delivery', quote });
  assert.equal(checkReturns(text, { days: 60, from: 'delivery', quote }), null, 'number not in the quote');
  assert.equal(checkReturns(text, { days: 30, from: 'delivery', quote: 'Returns within 30 days.' }), null, 'quote not in the text');
  assert.equal(checkReturns(text, { days: null, from: null, quote: null }), null);
});
