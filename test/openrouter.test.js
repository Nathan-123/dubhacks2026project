'use strict';

// OpenRouter is mocked at fetch() level: these tests never touch the network or spend anything.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENROUTER_API_KEY = 'sk-or-test';
delete process.env.FIT_ALLOW_PAID_MODELS;

const MODELS = {
  data: [
    { id: 'openrouter/free', pricing: { prompt: '0', completion: '0', request: '0' } },
    { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'some/paid-model', pricing: { prompt: '0.000002', completion: '0.00001' } },
  ],
};

const calls = [];
let chatReply = { confidence: 72, reason: 'Your own size plus plenty of reviews.' };
let rejectSchema = false;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null, headers: init && init.headers });
  const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  if (String(url).endsWith('/models')) return ok(MODELS);
  if (String(url).endsWith('/chat/completions')) {
    const body = JSON.parse(init.body);
    if (rejectSchema && body.response_format.type === 'json_schema') return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'json_schema unsupported' } }) };
    return ok({ model: 'routed/free-model', choices: [{ message: { content: '```json\n' + JSON.stringify(chatReply) + '\n```' } }] });
  }
  return { ok: false, status: 404, text: async () => '{}' };
};

const openrouter = require('../server/openrouter.js');
const confidence = require('../server/confidence.js');

const EVIDENCE = { personalized: true, baselineSource: 'stated', reviewCount: 188, itemRuns: 'true to size', rulesConfidence: 62 };

test('free models pass the guard; paid and unknown models are refused before any chat call', async () => {
  await openrouter.assertFree('openrouter/free');
  await openrouter.assertFree('google/gemma-4-31b-it:free');
  await assert.rejects(openrouter.assertFree('some/paid-model'), /not free/);
  await assert.rejects(openrouter.assertFree('made/up-model'), /not found/);
  const before = calls.filter((c) => c.url.endsWith('/chat/completions')).length;
  await assert.rejects(openrouter.chatJson({ model: 'some/paid-model', system: 's', user: 'u', schema: { type: 'object' } }), /not free/);
  assert.equal(calls.filter((c) => c.url.endsWith('/chat/completions')).length, before, 'no chat request was sent');
});

test('chatJson sends the key, strict JSON schema, temperature 0, and parses fenced JSON', async () => {
  const { json, model } = await openrouter.chatJson({ model: 'openrouter/free', system: 's', user: 'u', schema: { type: 'object' } });
  const last = calls.filter((c) => c.url.endsWith('/chat/completions')).pop();
  assert.equal(last.headers.Authorization, 'Bearer sk-or-test');
  assert.equal(last.body.temperature, 0);
  assert.equal(last.body.response_format.type, 'json_schema');
  assert.equal(json.confidence, 72);
  assert.equal(model, 'routed/free-model');
});

test('falls back to JSON mode when the routed free model rejects json_schema', async () => {
  rejectSchema = true;
  try {
    const { json } = await openrouter.chatJson({ model: 'openrouter/free', system: 's', user: 'u', schema: { type: 'object' } });
    assert.equal(json.confidence, 72);
    assert.equal(calls.filter((c) => c.url.endsWith('/chat/completions')).pop().body.response_format.type, 'json_object');
  } finally { rejectSchema = false; }
});

test('confidence.estimate returns the model number, caches it, and only sends the evidence summary', async () => {
  const n0 = calls.length;
  const a = await confidence.estimate(EVIDENCE);
  assert.equal(a.ok, true);
  assert.equal(a.confidence, 72);
  const sent = calls.slice(n0).find((c) => c.url.endsWith('/chat/completions'));
  assert.match(sent.body.messages[1].content, /rulesConfidence/);
  const b = await confidence.estimate(EVIDENCE);
  assert.equal(b.cached, true);
});

test('confidence.estimate rejects out-of-range model output instead of using it', async () => {
  chatReply = { confidence: 400, reason: 'x' };
  try {
    const r = await confidence.estimate({ ...EVIDENCE, reviewCount: 3 });
    assert.equal(r.ok, false);
  } finally { chatReply = { confidence: 72, reason: 'ok' }; }
});

test('rung-0 (not personalized) never calls the model', async () => {
  const r = await confidence.estimate({ personalized: false });
  assert.equal(r.ok, false);
});
