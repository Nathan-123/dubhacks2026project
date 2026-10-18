/*
 * FittingRoom backend. Stateless, holds no user data, costs nothing to run. It shares a
 * pre-cache of demo pages, runs the LLM tier on a free local model (Ollama), and makes
 * scoring tunable without reloading the extension.
 *
 *   POST /extract-product   trimmed page text + JSON-LD (+ partial Product) -> Product
 *   POST /score-fit         profile + product -> Recommendation (model confidence if available)
 *   POST /confidence        evidence summary -> model confidence (free OpenRouter model)
 *   POST /parse-order       scrubbed order line items -> wardrobe items
 *   GET  /health
 *
 * Extraction results are cached per canonical URL on disk (server/cache), which is
 * also the offline fallback for demo pages.
 */
'use strict';

require('./env.js'); // .env -> process.env (OPENROUTER_API_KEY etc.)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const contract = require('../extension/lib/contract.js');
const scorer = require('../extension/lib/score.js');
const orders = require('./orders.js');
const llm = require('./llm.js');
const confidence = require('./confidence.js');

const PORT = Number(process.env.PORT || 8787);
const CACHE_DIR = process.env.FIT_CACHE_DIR || path.join(__dirname, 'cache');
const MAX_BODY = 2 * 1024 * 1024;

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// cache

function cachePath(url) {
  const key = crypto.createHash('sha1').update(contract.canonicalUrl(url)).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `${key}.json`);
}
function cacheGet(url) {
  try { return JSON.parse(fs.readFileSync(cachePath(url), 'utf8')); } catch (_) { return null; }
}
function cachePut(url, product) {
  fs.writeFileSync(cachePath(url), JSON.stringify({ canonical: contract.canonicalUrl(url), at: new Date().toISOString(), product }, null, 2));
}

// ---------------------------------------------------------------------------
// handlers

/**
 * Cache first; otherwise fill the gaps in the extension's partial Product with the
 * free local LLM (tier 5). The LLM only fills gaps, never overwrites on-device fields.
 */
async function extractProduct(body) {
  const { url, text, jsonld, partial } = body;
  if (!url) return [400, { ok: false, error: 'url required' }];

  const cached = cacheGet(url);
  if (cached && cached.product && !contract.missingFloor(cached.product).length) {
    return [200, { ok: true, product: cached.product, cached: true }];
  }

  const product = partial && partial.identity ? partial : contract.emptyProduct(url);
  if (!product._src) product._src = {};

  if (contract.missingFloor(product).length) {
    try {
      contract.mergeGaps(product, await llm.extractProduct({ url, text, jsonld }));
    } catch (e) {
      return [e.code === 'llm_unavailable' ? 503 : 502, { ok: false, error: e.code || 'llm_error', detail: e.message }];
    }
  }

  const missing = contract.missingFloor(product).filter((p) => p !== 'identity.brand');
  if (missing.length) return [422, { ok: false, error: 'floor-missing', missing }];
  const unsourced = contract.unsourced(product);
  if (unsourced.length) return [500, { ok: false, error: 'contract violation: unsourced fields', unsourced }];

  cachePut(url, product);
  return [200, { ok: true, product }];
}

async function scoreFit(body) {
  const { product, profile, opts } = body;
  if (!product) return [400, { ok: false, error: 'product required' }];
  const started = process.hrtime.bigint();
  let rec = scorer.score(product, profile || {}, opts || {});
  if (rec.personalized && rec.evidence && (opts || {}).modelConfidence !== false) {
    const mc = await confidence.estimate(rec.evidence);
    if (mc.ok) rec = scorer.score(product, profile || {}, { ...(opts || {}), confidenceOverride: mc });
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return [200, {
    ok: true,
    recommendation: rec,
    // Flat aliases matching the API contract in the build plan.
    best_size: rec.size,
    scores_by_size: Object.fromEntries((rec.scores || []).map((s) => [s.label, s.score])),
    confidence: rec.confidence,
    reason: rec.reason,
    alert: rec.alert,
    ms: +ms.toFixed(2),
  }];
}

async function parseOrder(body) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  // Defense in depth: the content script already scrubbed; drop anything that still looks like PII.
  const clean = items.map(orders.scrubItem).filter(Boolean);
  if (!clean.length) return [400, { ok: false, error: 'no line items' }];
  const base = orders.heuristicParse(clean, body.brand);
  try {
    // The free local model only labels brand/category; size and price come from the page.
    const labeled = await llm.parseOrder({ items: base, brand: body.brand });
    return [200, { ok: true, items: labeled.map((it, i) => ({ ...base[i], brand: it.brand || base[i].brand, category: it.category || base[i].category, subcategory: it.subcategory || base[i].subcategory })), via: 'llm' }];
  } catch (_) {
    return [200, { ok: true, items: base, via: 'heuristic' }];
  }
}

// A store's return window, when the extension could not read it plainly from the policy page.
async function returnPolicy(body) {
  if (!body.text) return [400, { ok: false, error: 'no policy text' }];
  try {
    const policy = await llm.returnPolicy({ text: body.text });
    return policy ? [200, { ok: true, ...policy }] : [200, { ok: false, error: 'no clear return window' }];
  } catch (_) {
    return [503, { ok: false, error: 'llm unavailable' }];
  }
}

async function modelConfidence(body) {
  const out = await confidence.estimate(body.evidence);
  return [out.ok ? 200 : 503, out];
}

const ROUTES = {
  'POST /confidence': modelConfidence,
  'POST /extract-product': extractProduct,
  'POST /score-fit': scoreFit,
  'POST /parse-order': parseOrder,
  'POST /return-policy': returnPolicy,
  'GET /health': async () => [200, { ok: true, llm: await llm.status(), confidence: await confidence.status(), cacheEntries: fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).length }],
};

// ---------------------------------------------------------------------------
// http

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const route = ROUTES[`${req.method} ${req.url.split('?')[0]}`];
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!route) return send(404, { ok: false, error: 'not found' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const [status, out] = await route(body);
      send(status, out);
    } catch (e) {
      send(e.status || 500, { ok: false, error: e.message });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`FittingRoom backend on http://localhost:${PORT}`);
    llm.status().then((s) => console.log(s.ok ? `LLM tier ready: ${s.model} via ${s.provider} (free)` : `LLM tier off (${s.provider}): ${s.reason}`));
    confidence.status().then((s) => console.log(s.ok ? `Confidence model ready: ${s.model} via OpenRouter (free)` : `Confidence model off: ${s.reason} — using rule-based confidence`));
  });
}

module.exports = { createServer, extractProduct, scoreFit, parseOrder };
