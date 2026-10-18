/*
 * openrouter — OpenAI-compatible chat client for https://openrouter.ai, FREE models only.
 *
 * Key: OPENROUTER_API_KEY in .env (see .env.example). Before the first call to a model we
 * look it up in OpenRouter's public model list and refuse it unless its prompt, completion
 * and request prices are all zero, so a typo or a paid model ID can never cost money.
 * (FIT_ALLOW_PAID_MODELS=1 lifts the guard; leave it unset for the hackathon.)
 *
 * Free models are rate-limited by OpenRouter, so callers cache results.
 */
'use strict';

const BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 20000);

let modelList = null;
let modelListAt = 0;

function configured() {
  return !!process.env.OPENROUTER_API_KEY;
}

async function http(path, { method = 'GET', body, timeoutMs } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}),
        'HTTP-Referer': 'http://localhost:8787',
        'X-Title': 'FitCheck',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON error page */ }
    if (!r.ok) {
      const msg = (json && json.error && json.error.message) || text.slice(0, 200);
      throw Object.assign(new Error(`OpenRouter HTTP ${r.status}: ${msg}`), { code: r.status === 429 ? 'rate_limited' : 'llm_error', status: r.status });
    }
    return json;
  } catch (e) {
    if (e.code) throw e;
    throw Object.assign(new Error(e.name === 'AbortError' ? 'OpenRouter timed out' : 'OpenRouter not reachable'), { code: 'llm_unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

async function models() {
  if (modelList && Date.now() - modelListAt < 3600e3) return modelList;
  const j = await http('/models', { timeoutMs: 8000 });
  modelList = j.data || [];
  modelListAt = Date.now();
  return modelList;
}

/** Throws unless `id` is a zero-priced model. */
async function assertFree(id) {
  if (process.env.FIT_ALLOW_PAID_MODELS === '1') return;
  const m = (await models()).find((x) => x.id === id);
  if (!m) throw Object.assign(new Error(`OpenRouter model "${id}" not found — pick one ending in ":free" (or "openrouter/free")`), { code: 'not_free' });
  const p = m.pricing || {};
  const paid = ['prompt', 'completion', 'request'].some((k) => Number(p[k] || 0) > 0);
  if (paid) throw Object.assign(new Error(`OpenRouter model "${id}" is not free; refusing to call it`), { code: 'not_free' });
}

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* fall through */ }
  const fenced = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(fenced); } catch (_) { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* give up */ } }
  return null;
}

/**
 * Chat completion that returns parsed JSON. Asks for strict JSON-schema output; if the
 * routed free model does not support it, retries in plain JSON mode with the schema in the prompt.
 */
async function chatJson({ model, system, user, schema, name }) {
  if (!configured()) throw Object.assign(new Error('OPENROUTER_API_KEY not set'), { code: 'llm_unavailable' });
  await assertFree(model);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let res;
  try {
    res = await http('/chat/completions', {
      method: 'POST',
      body: { model, messages, temperature: 0, response_format: { type: 'json_schema', json_schema: { name: name || 'result', strict: true, schema } } },
    });
  } catch (e) {
    if (e.status !== 400) throw e;
    res = await http('/chat/completions', {
      method: 'POST',
      body: {
        model, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: `${system}\n\nReply with only a JSON object matching this JSON schema:\n${JSON.stringify(schema)}` }, messages[1]],
      },
    });
  }
  const choice = res && res.choices && res.choices[0];
  const out = parseJsonLoose(choice && choice.message && choice.message.content);
  if (!out) throw Object.assign(new Error('model returned invalid JSON'), { code: 'llm_error' });
  return { json: out, model: res.model || model };
}

/** { ok, reason } for /health. */
async function status(model) {
  if (!configured()) return { ok: false, reason: 'OPENROUTER_API_KEY not set in .env' };
  try {
    await assertFree(model);
    return { ok: true, model };
  } catch (e) {
    return { ok: false, model, reason: e.message };
  }
}

module.exports = { configured, chatJson, assertFree, status, parseJsonLoose };
