/*
 * llm — extraction tier 5 and order normalization, on FREE models only. Two providers:
 *
 *   openrouter  free models via OpenRouter (default when OPENROUTER_API_KEY is set);
 *               server/openrouter.js refuses any model that is not $0.
 *   ollama      open models running on this machine (no key, nothing leaves the laptop):
 *                 winget install Ollama.Ollama ; ollama pull qwen2.5:3b
 *
 * Choose with FIT_LLM_PROVIDER. If the provider is unavailable, tier 5 reports itself
 * unavailable and the extension falls back to cached or on-device results.
 */
'use strict';

const sizes = require('../extension/lib/sizes.js');
const contract = require('../extension/lib/contract.js');
const openrouter = require('./openrouter.js');

const provider = () => process.env.FIT_LLM_PROVIDER || (openrouter.configured() ? 'openrouter' : 'ollama');
const extractModel = () => process.env.EXTRACT_MODEL || 'openrouter/free';

const ollamaUrl = () => (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
// Small, fast on a laptop CPU, and good at schema-constrained JSON extraction.
const MODEL = process.env.FIT_LLM_MODEL || 'qwen2.5:3b';
const TIMEOUT_MS = Number(process.env.FIT_LLM_TIMEOUT_MS || 45000);
const TEXT_LIMIT = 8000; // small models do better (and faster) with a tight product-region excerpt

async function ollama(path, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(`${ollamaUrl()}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!r.ok) throw Object.assign(new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { code: 'llm_error' });
    return await r.json();
  } catch (e) {
    if (e.code) throw e;
    throw Object.assign(new Error(e.name === 'AbortError' ? 'Ollama timed out' : `Ollama not reachable at ${ollamaUrl()}`), { code: 'llm_unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

/** { ok, provider, model, reason } — is the configured free provider ready? */
async function status() {
  if (provider() === 'openrouter') return { provider: 'openrouter', ...(await openrouter.status(extractModel())) };
  return { provider: 'ollama', ...(await ollamaStatus()) };
}

async function ollamaStatus() {
  try {
    const tags = await ollama('/api/tags', null, 1500);
    const names = (tags.models || []).map((m) => m.name);
    const have = names.some((n) => n === MODEL || n === `${MODEL}:latest` || n.split(':')[0] === MODEL);
    return have ? { ok: true, model: MODEL } : { ok: false, model: MODEL, reason: `model not pulled — run: ollama pull ${MODEL}` };
  } catch (_) {
    return { ok: false, model: MODEL, reason: 'Ollama not running — install from ollama.com, then: ollama pull ' + MODEL };
  }
}

/** OpenAI-style strict schemas need additionalProperties:false on every object. */
function strict(schema) {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strict(pv)])) : strict(v);
  if (out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'))) out.additionalProperties = false;
  return out;
}

async function callJson(system, user, schema) {
  if (provider() === 'openrouter') {
    return (await openrouter.chatJson({ model: extractModel(), name: 'extract', system, user, schema: strict(schema) })).json;
  }
  const res = await ollama('/api/chat', {
    model: MODEL,
    stream: false,
    format: schema, // Ollama structured outputs: the reply is constrained to this JSON schema
    options: { temperature: 0, num_ctx: 8192 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const text = res && res.message && res.message.content;
  try { return JSON.parse(text); } catch (_) { throw Object.assign(new Error('model returned invalid JSON'), { code: 'llm_error' }); }
}

const nullable = (type) => ({ type: [type, 'null'] });

const PRODUCT_SCHEMA = {
  type: 'object',
  required: ['brand', 'name', 'category', 'section', 'cutHint', 'sizes', 'sizeChart', 'fabric', 'modelRef', 'reviewFit'],
  properties: {
    brand: nullable('string'),
    name: nullable('string'),
    category: { type: ['string', 'null'], enum: ['top', 'bottom', 'outerwear', 'dress', 'shoes', null] },
    section: { type: ['string', 'null'], enum: ['men', 'women', 'unisex', null] },
    cutHint: nullable('string'),
    sizes: {
      type: 'array',
      items: { type: 'object', required: ['label', 'available'], properties: { label: { type: 'string' }, available: { type: 'boolean' } } },
    },
    sizeChart: {
      type: 'object',
      required: ['kind', 'unit', 'rows'],
      properties: {
        kind: { type: 'string', enum: ['garment', 'body', 'unknown'] },
        unit: { type: ['string', 'null'], enum: ['in', 'cm', null] },
        rows: {
          type: 'array',
          items: {
            type: 'object', required: ['size', 'measurements'],
            properties: {
              size: { type: 'string' },
              measurements: {
                type: 'array',
                items: {
                  type: 'object', required: ['name', 'value'],
                  properties: { name: { type: 'string', enum: ['chest', 'pitToPit', 'waist', 'hip', 'inseam', 'rise', 'sleeve', 'shoulder', 'thigh', 'bodyLength'] }, value: { type: 'number' } },
                },
              },
            },
          },
        },
      },
    },
    fabric: {
      type: 'object', required: ['composition', 'stretch'],
      properties: {
        composition: { type: 'array', items: { type: 'object', required: ['material', 'pct'], properties: { material: { type: 'string' }, pct: { type: 'number' } } } },
        stretch: { type: 'boolean' },
      },
    },
    modelRef: { type: 'object', required: ['heightCm', 'sizeWorn'], properties: { heightCm: nullable('number'), sizeWorn: nullable('string') } },
    reviewFit: {
      type: 'object', required: ['label', 'pctRunsSmall', 'pctTrueToSize', 'pctRunsLarge', 'n'],
      properties: {
        label: { type: ['string', 'null'], enum: ['runs small', 'true to size', 'runs large', null] },
        pctRunsSmall: nullable('number'),
        pctTrueToSize: nullable('number'),
        pctRunsLarge: nullable('number'),
        n: nullable('integer'),
      },
    },
  },
};

const EXTRACT_SYSTEM = `You read the visible text of one clothing product page and report structured facts for a sizing tool. Reply with JSON only.

Report only what the text states. If something is not on the page, use null, an empty array, or "unknown". A guessed value is harmful because a shopper will buy based on it.
- sizes: the size options a shopper can pick, exactly as labeled. available=false only if the text says that size is sold out.
- sizeChart.kind: "garment" if measurements describe the item (laid flat, pit to pit, product measurements); "body" if they describe the wearer (to fit, body measurements); else "unknown". Use the midpoint of ranges.
- reviewFit: only aggregate fit facts shown on the page, e.g. "62% say runs small". Percentages as 0-1 fractions. Never copy review text.
- section: the store section (men/women/unisex) only if the page says it.`;

/** Convert model output to the Product contract, every field sourced as "llm". */
function toProduct(out, url, pageText) {
  const p = contract.emptyProduct(url);
  const S = 'llm';
  out = out || {};
  contract.fill(p, 'identity.brand', out.brand, S);
  contract.fill(p, 'identity.name', out.name, S);
  contract.fill(p, 'identity.category', out.category, S);
  contract.fill(p, 'identity.section', out.section, S);
  contract.fill(p, 'identity.cutHint', out.cutHint, S);

  // Hallucination guard: small models invent things, so only keep facts the page text contains.
  const haystack = ` ${String(pageText || '').replace(/\s+/g, ' ')} `;
  const appears = (s) => new RegExp(`(^|[^A-Za-z0-9])${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(haystack);
  const opts = (out.sizes || []).filter((s) => s && sizes.isSizeLabel(s.label) && appears(s.label))
    .map((s) => ({ label: String(s.label), available: s.available !== false, selected: false }));
  if (opts.length) {
    contract.fill(p, 'sizes.options', opts, S);
    p.sizes.system = sizes.detectSystem(opts.map((o) => o.label));
  }
  if (p.identity.brand && !appears(p.identity.brand)) { p.identity.brand = null; delete p._src['identity.brand']; }

  const chart = out.sizeChart;
  if (chart && Array.isArray(chart.rows) && chart.rows.length) {
    const rows = chart.rows
      .filter((r) => r && appears(r.size))
      .map((r) => Object.assign({ size: r.size }, ...(r.measurements || []).filter((m) => m && appears(m.value)).map((m) => ({ [m.name]: m.value }))))
      .filter((r) => Object.keys(r).length > 1);
    if (rows.length >= 2) contract.fill(p, 'sizeChart', { kind: chart.kind || 'unknown', unit: chart.unit || null, rows, imageOnly: false }, S);
  }
  const comp = ((out.fabric && out.fabric.composition) || []).filter((c) => c && appears(c.pct) && appears(c.material));
  if (comp.length) contract.fill(p, 'fabric', { composition: comp, stretch: !!out.fabric.stretch }, S);
  if (out.modelRef && out.modelRef.heightCm && out.modelRef.sizeWorn && appears(out.modelRef.sizeWorn)) contract.fill(p, 'modelRef', out.modelRef, S);

  const rf = out.reviewFit || {};
  const pctSeen = (x) => x != null && appears(String(Math.round(x * 100)));
  if (pctSeen(rf.pctRunsSmall) || pctSeen(rf.pctRunsLarge)) {
    contract.fill(p, 'reviewFit.distribution', { runsSmall: rf.pctRunsSmall || 0, trueToSize: rf.pctTrueToSize || 0, runsLarge: rf.pctRunsLarge || 0 }, S);
  } else if (rf.label && appears(rf.label)) {
    const scale = rf.label === 'runs small' ? -1 : rf.label === 'runs large' ? 1 : 0;
    contract.fill(p, 'reviewFit.aggregate', { scale, label: rf.label, n: rf.n || null, source: 'llm' }, S);
  }
  if (rf.n != null && appears(rf.n)) p.reviewFit.n = rf.n;
  return p;
}

async function extractProduct({ url, text, jsonld }) {
  const pageText = String(text || '').slice(0, TEXT_LIMIT);
  const ld = JSON.stringify(jsonld || []).slice(0, 3000);
  const user = `URL: ${url}\n\nJSON-LD (may be empty): ${ld}\n\nPage text:\n${pageText}`;
  const out = await callJson(EXTRACT_SYSTEM, user, PRODUCT_SCHEMA);
  return toProduct(out, url, `${pageText} ${ld}`);
}

const ORDER_SCHEMA = {
  type: 'object', required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', required: ['name', 'brand', 'category', 'subcategory'],
        properties: {
          name: { type: 'string' },
          brand: nullable('string'),
          category: { type: ['string', 'null'], enum: ['top', 'bottom', 'outerwear', 'dress', 'shoes', null] },
          subcategory: nullable('string'),
        },
      },
    },
  },
};

const ORDER_SYSTEM = `You label clothing order line items. Reply with JSON only, one entry per input item, same order.
brand: the brand named in the item name, else the store brand given. category/subcategory from the item name (e.g. "Slim Jeans" -> bottom / jeans). null when unsure.`;

/** Fills brand/category only; size and price always come from the page, never the model. */
async function parseOrder({ items, brand }) {
  const out = await callJson(ORDER_SYSTEM, `Store brand: ${brand || 'unknown'}\nItems: ${JSON.stringify(items.map((i) => i.name))}`, ORDER_SCHEMA);
  return items.map((it, i) => {
    const o = (out.items || [])[i] || {};
    return { ...it, brand: o.brand || brand || null, category: o.category || null, subcategory: o.subcategory || null };
  });
}

const RETURNS_SCHEMA = {
  type: 'object', required: ['days', 'from', 'quote'],
  properties: {
    days: nullable('integer'),
    from: { type: ['string', 'null'], enum: ['delivery', 'shipping', 'purchase', null] },
    quote: nullable('string'),
  },
};

const RETURNS_SYSTEM = `You read a clothing store's return policy. Reply with JSON only.
days: the standard number of days a US shopper has to return an online order for a refund (not holiday extensions, sale items or refund processing time). null when the text does not say.
from: what that window counts from. quote: the exact sentence from the text that states it, copied word for word.`;

/**
 * The model's answer counts only if its quote is really in the policy text and names the same number
 * of days, so a made-up window can never reach a shopper. -> { days, from, quote } | null
 */
function checkReturns(text, out) {
  if (!out || !Number.isInteger(out.days) || out.days < 7 || out.days > 365 || !out.quote) return null;
  const flat = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!flat(text).includes(flat(out.quote)) || !new RegExp(`\\b${out.days}\\b`).test(out.quote)) return null;
  return { days: out.days, from: out.from || 'purchase', quote: out.quote };
}

async function returnPolicy({ text }) {
  const policy = String(text || '').slice(0, 12000);
  return checkReturns(policy, await callJson(RETURNS_SYSTEM, policy, RETURNS_SCHEMA));
}

module.exports = { status, extractProduct, parseOrder, returnPolicy, checkReturns, toProduct, MODEL };
