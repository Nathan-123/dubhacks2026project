/*
 * confidence — model-based confidence for a size recommendation, via OpenRouter (free models).
 *
 * The fit score stays rule-based (it is arithmetic over sizes). Confidence answers a fuzzier
 * question, "how much should a shopper trust this?", which is where a model can help. The
 * model sees only the evidence summary built by score.js: which kinds of data exist and how
 * much of it. No sizes, no brands, no wardrobe contents.
 *
 * This is the seam for the team's own confidence model: change CONFIDENCE_MODEL (any free
 * OpenRouter model ID) or replace estimate() entirely. If the model is unavailable, slow or
 * returns junk, callers fall back to the rule-based number.
 */
'use strict';

const crypto = require('crypto');
const openrouter = require('./openrouter.js');

const MODEL = process.env.CONFIDENCE_MODEL || 'openrouter/free';
const cache = new Map();
const CACHE_MAX = 500;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confidence', 'reason'],
  properties: {
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reason: { type: 'string' },
  },
};

const SYSTEM = `You rate how much a shopper should trust a clothing size recommendation, from 0 to 100.
You are given only a summary of the evidence behind it. Judge the evidence, not the clothing.

How to weigh it:
- The shopper's own data matters most: fit feedback on items from this same brand > orders from this brand > sizes they usually keep > a size they simply told us.
- Item evidence: many fit reviews with a clear majority are strong; a handful of reviews is weak; no reviews means we cannot tell whether the item runs small or large.
- A garment measurement chart matched to the shopper's reference item is strong; a body chart or unknown chart is weak; an image-only chart adds nothing.
- Lower confidence for: a size borrowed from another category, inconsistent feedback on this brand, a stated size the wardrobe contradicts, a page read by a fallback reader, and recommendations at the very edge of the size range (fewer reviewers there).
- 80+ means strong evidence on both the shopper and the item. Below 40 means the recommendation is mostly a guess.

rulesConfidence is a simple points-based estimate you may agree or disagree with.
reason: one short, plain sentence a shopper would understand, under 20 words, no numbers.`;

function key(evidence) {
  return crypto.createHash('sha1').update(MODEL + JSON.stringify(evidence)).digest('hex');
}

/** Returns { ok, confidence, reason, model, cached } or { ok:false, error }. */
async function estimate(evidence) {
  if (!evidence || !evidence.personalized) return { ok: false, error: 'not_personalized' };
  const k = key(evidence);
  if (cache.has(k)) return { ...cache.get(k), cached: true };
  try {
    const { json, model } = await openrouter.chatJson({
      model: MODEL, name: 'confidence', system: SYSTEM, schema: SCHEMA,
      user: `Evidence:\n${JSON.stringify(evidence, null, 2)}`,
    });
    const c = Math.round(Number(json.confidence));
    if (!Number.isFinite(c) || c < 0 || c > 100) return { ok: false, error: 'bad_model_output' };
    const out = { ok: true, confidence: c, reason: String(json.reason || '').slice(0, 160), model };
    cache.set(k, out);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return out;
  } catch (e) {
    return { ok: false, error: e.code || 'llm_error', detail: e.message };
  }
}

function status() {
  return openrouter.status(MODEL);
}

module.exports = { estimate, status, MODEL, SCHEMA, SYSTEM };
