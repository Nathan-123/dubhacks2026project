'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { score, popupView } = require('../extension/lib/score.js');
const profileMod = require('../extension/lib/profile.js');
const { runCase } = require('../scripts/extract-fixture.js');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/manifest.json'), 'utf8'));
const NOW = new Date('2026-10-17T22:10:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 10);

async function product(name) {
  const res = await runCase(manifest.cases.find((c) => c.name === name));
  return res.product;
}
const jacket = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/products/af-jacket.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const run = (p, prof, opts) => score(p, prof, { now: NOW, ...(opts || {}) });

function profileWith(events) {
  return events.reduce((p, e) => profileMod.apply(p, { at: new Date(NOW).toISOString(), ...e }), profileMod.emptyProfile());
}

// --- rung 0 ------------------------------------------------------------------

test('rung 0: empty profile gives an honest crowd verdict, not personalized', async () => {
  const rec = run(await product('shopify-tee'), {});
  assert.equal(rec.state, 'runsSmall');
  assert.equal(rec.verdict, 'Runs small');
  assert.equal(rec.personalized, false);
  assert.equal(rec.size, null);
  assert.match(rec.reason, /62% of 412 reviewers/);
  assert.equal(rec.ask.type, 'usualSize');
  assert.deepEqual(rec.ask.options, ['S', 'M', 'L', 'XL']);
});

test('rung 0: neutral offset reads True to size with review count', async () => {
  const rec = run(await product('next-jeans'), {});
  assert.equal(rec.state, 'trueToSize');
  assert.match(rec.reason, /188 reviews/);
});

test('rung 0: no data at all is low confidence, never a guess', async () => {
  const p = await product('indie-select');
  const rec = run(p, {});
  assert.equal(rec.state, 'lowConfidence');
  assert.equal(rec.size, null);
});

// --- rung 1 ------------------------------------------------------------------

test('rung 1: usual M + runs small + M selected -> Size up to L... which is sold out, so say so', async () => {
  const p = await product('shopify-tee');
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' }]);
  const rec = run(p, prof);
  assert.equal(rec.personalized, true);
  // L is ideal but unavailable: never silently recommend something unbuyable.
  assert.notEqual(rec.size, 'L');
  assert.match(rec.reason, /L would fit you best, but it’s sold out/);
});

test('rung 1: usual M + runs small, L in stock and M selected -> Size up -> L with both scores', async () => {
  const p = await product('shopify-tee');
  p.sizes.options.find((o) => o.label === 'L').available = true;
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' }]);
  const rec = run(p, prof);
  assert.equal(rec.state, 'sizeChange');
  assert.equal(rec.verdict, 'Size up → L');
  assert.equal(rec.selected, 'M');
  const m = rec.scores.find((s) => s.label === 'M');
  const l = rec.scores.find((s) => s.label === 'L');
  assert.ok(l.score >= 80 && m.score < l.score);
  assert.match(rec.reason, /You picked M/);
  assert.ok(rec.basis.includes('Your usual size'));
  assert.ok(rec.basis.some((b) => /412 reviews/.test(b)));

  // Clicking L flips the badge to Good buy.
  p.sizes.options.forEach((o) => { o.selected = o.label === 'L'; });
  const after = run(p, prof);
  assert.equal(after.state, 'goodBuy');
  assert.equal(after.size, 'L');
});

test('demo beat: Uniqlo jeans, usual 29, true to size -> Good buy · 29', async () => {
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'bottom', label: '29', system: 'waist' }]);
  const rec = run(await product('next-jeans'), prof);
  assert.equal(rec.state, 'goodBuy');
  assert.equal(rec.verdict, 'Good buy · 29');
  assert.ok(rec.confidence >= 40);
});

test('missing data lowers confidence, never the fit score', async () => {
  const p = await product('next-jeans');
  p.reviewFit.aggregate.scale = 0; // isolate missingness from the signal's direction
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'bottom', label: '29', system: 'waist' }]);
  const full = run(p, prof);
  const bare = clone(p);
  bare.reviewFit = { aggregate: null, distribution: null, reviewers: null, n: null };
  delete bare._src['reviewFit.aggregate'];
  const thin = run(bare, prof);
  assert.equal(thin.fitRaw, full.fit, 'the underlying fit score is unchanged');
  assert.ok(thin.confidence < full.confidence);
  assert.equal(thin.state, 'lowConfidence');
  assert.equal(thin.verdict, 'Best guess · 29');
  assert.equal(thin.fit, null, 'no fit number is shown when confidence is low');
  assert.ok(thin.scores.every((s) => s.score === null));
});

// --- rungs 2 and 3 -------------------------------------------------------------

test('money shot: fit feedback on the same brand raises confidence', async () => {
  const p = await product('next-jeans');
  const base = profileWith([
    { type: 'setUsualSize', section: 'men', category: 'bottom', label: '29', system: 'waist' },
    { type: 'addItem', item: { id: 'j1', brand: 'Uniqlo', name: 'Slim Jeans', category: 'bottom', section: 'men', size: '29', date: daysAgo(9) } },
  ]);
  const before = run(p, base);
  const after = run(p, profileMod.apply(base, { type: 'setFeedback', id: 'j1', feedback: 'perfect', at: new Date(NOW).toISOString() }));
  assert.equal(before.state, 'goodBuy');
  assert.equal(after.state, 'goodBuy');
  assert.ok(after.confidence >= before.confidence + 10, `confidence ${before.confidence} -> ${after.confidence}`);
  assert.match(after.reason, /Uniqlo 29 that fit well/);
});

test('demo beat: A&F jacket after an A&F XL that ran small -> Likely return + you own 2 like this', () => {
  const prof = profileWith([
    { type: 'addItem', item: { brand: 'Abercrombie & Fitch', name: 'Trucker Jacket', category: 'outerwear', subcategory: 'jacket', section: 'men', size: 'XL', date: daysAgo(210), feedback: 'small', feedbackAt: daysAgo(196) } },
    { type: 'addItem', item: { brand: 'Patagonia', name: 'Better Sweater', category: 'outerwear', subcategory: 'jacket', section: 'men', size: 'L', date: daysAgo(120), feedback: 'perfect' } },
  ]);
  const rec = run(jacket(), prof);
  assert.equal(rec.state, 'likelyReturn');
  assert.match(rec.reason, /largest size available/);
  assert.equal(rec.alert.kind, 'duplicate');
  assert.match(rec.alert.text, /You own 2 like this/);
});

test('wardrobe overrides stated size only when two or more items agree', async () => {
  const p = await product('next-jeans');
  const stated = { type: 'setUsualSize', section: 'men', category: 'bottom', label: '29', system: 'waist' };
  const item = (brand) => ({ type: 'addItem', item: { brand, name: 'Jeans', category: 'bottom', section: 'men', size: '31', date: daysAgo(30) } });
  const one = run(p, profileWith([stated, item('Levis')]));
  assert.equal(one.size, '29');
  const two = run(p, profileWith([stated, item('Levis'), item('Gap')]));
  assert.equal(two.size, '31');
  assert.equal(two.alert.kind, 'fit');
  assert.match(two.alert.text, /wardrobe says 31/i);
});

test('contradictory feedback on one brand drops confidence and says so', () => {
  const prof = profileWith([
    { type: 'addItem', item: { id: 'a', brand: 'Abercrombie & Fitch', category: 'outerwear', section: 'men', size: 'M', date: daysAgo(40), feedback: 'perfect' } },
    { type: 'addItem', item: { id: 'b', brand: 'Abercrombie & Fitch', category: 'outerwear', section: 'men', size: 'M', date: daysAgo(20), feedback: 'small' } },
  ]);
  const rec = run(jacket(), prof);
  assert.match(rec.alert.text, /inconsistently/);
  const consistent = run(jacket(), profileWith([{ type: 'addItem', item: { brand: 'Abercrombie & Fitch', category: 'outerwear', section: 'men', size: 'M', date: daysAgo(40), feedback: 'perfect' } }]));
  assert.ok(rec.confidence < consistent.confidence);
});

test('no outerwear baseline borrows from tops with lower confidence and says so', () => {
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' }]);
  const rec = run(jacket(), prof);
  assert.equal(rec.why.baseline.borrowedFrom, 'top');
  assert.match(rec.reason, /usual top M|Borrowed from your top size/);
  assert.ok(rec.ask, 'still asks for the real category size');
});

test('one-size items report fit and suppress the size recommendation', () => {
  const p = jacket();
  p.sizes.options = [{ label: 'One Size', available: true, selected: false }];
  const rec = run(p, profileWith([{ type: 'setUsualSize', section: 'men', category: 'outerwear', label: 'M', system: 'alpha' }]));
  assert.ok(!/size up|size down/i.test(rec.verdict));
  assert.equal(rec.ask, null);
});

test('baselines are per section: a women’s size does not leak into men’s', () => {
  const prof = profileWith([{ type: 'setUsualSize', section: 'women', category: 'outerwear', label: 'S', system: 'alpha' }]);
  const rec = run(jacket(), prof);
  assert.equal(rec.personalized, false);
});

test('deleting everything reverts to rung 0 immediately', async () => {
  const p = await product('shopify-tee');
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' }]);
  assert.equal(run(p, prof).personalized, true);
  assert.equal(run(p, profileMod.apply(prof, { type: 'deleteAll' })).personalized, false);
});

test('after the size, asks once how the shopper likes things to fit', async () => {
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' }]);
  const rec = run(await product('shopify-tee'), prof);
  assert.equal(rec.personalized, true);
  assert.equal(rec.ask.type, 'fitPreference');
  assert.deepEqual(rec.ask.options, ['Slim', 'Regular', 'Relaxed', 'Oversized']);
  assert.deepEqual(rec.ask.values, ['fitted', 'regular', 'relaxed', 'oversized']);
});

test('a saved or dismissed fit preference is not asked again', async () => {
  const prof = profileWith([
    { type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' },
    { type: 'setPreference', preference: 'regular' },
  ]);
  assert.equal(run(await product('shopify-tee'), prof).ask, null);
  const noPref = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' }]);
  assert.equal(run(await product('shopify-tee'), noPref, { prefDismissed: true }).ask, null);
});

test('a missing category size is asked before fit preference', () => {
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' }]);
  assert.equal(run(jacket(), prof).ask.type, 'usualSize');
});

test('relaxed fit aims larger than slim fit', async () => {
  const p = await product('shopify-tee');
  const withPref = (preference) => profileWith([
    { type: 'setUsualSize', section: 'men', category: 'top', label: 'M', system: 'alpha' },
    { type: 'setPreference', preference },
  ]);
  assert.ok(run(p, withPref('relaxed')).why.target > run(p, withPref('fitted')).why.target);
  assert.ok(run(p, withPref('oversized')).why.target > run(p, withPref('relaxed')).why.target);
});

test('the onboarding best-fitting piece personalizes other brands', async () => {
  const prof = profileWith([{ type: 'setAnchorItems', items: [{ brand: 'Uniqlo', category: 'top', section: 'men', size: 'M' }] }]);
  const rec = run(await product('shopify-tee'), prof);
  assert.equal(rec.personalized, true);
  assert.equal(rec.why.baseline.label, 'M');
});

test('a best-fitting bottom does not change the size for a top', async () => {
  const prof = profileWith([{ type: 'setAnchorItems', items: [
    { brand: 'Uniqlo', category: 'top', section: 'men', size: 'M' },
    { brand: "Levi's", category: 'bottom', section: 'men', size: '36x32', system: 'waistInseam' },
  ] }]);
  const rec = run(await product('shopify-tee'), prof);
  assert.equal(rec.why.baseline.label, 'M');
});

test('dismissing the usual-size ask hides it', async () => {
  const rec = run(await product('shopify-tee'), {}, { askDismissed: true });
  assert.equal(rec.ask, null);
});

test('recent feedback outweighs old feedback', () => {
  const old = { type: 'addItem', item: { brand: 'Abercrombie & Fitch', category: 'outerwear', section: 'men', size: 'S', date: daysAgo(720), feedbackAt: daysAgo(700), feedback: 'perfect' } };
  const recent = { type: 'addItem', item: { brand: 'Abercrombie & Fitch', category: 'outerwear', section: 'men', size: 'L', date: daysAgo(20), feedbackAt: daysAgo(10), feedback: 'perfect' } };
  const rec = run(jacket(), profileWith([old, recent]));
  assert.equal(rec.size, 'L');
});

test('every recommendation explains itself in one sentence, except "No fit data yet", whose title says it all', async () => {
  for (const name of ['shopify-tee', 'next-jeans', 'indie-select']) {
    const rec = run(await product(name), profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M' }]));
    if (rec.verdict === 'No fit data yet') assert.equal(rec.reason, '', `${name} reason`);
    else assert.ok(rec.reason && rec.reason.length > 10, `${name} reason`);
  }
});

test('scores in under 50ms on cached data', async () => {
  const p = await product('shopify-tee');
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'top', label: 'M' }]);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) run(p, prof);
  const perCall = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
  assert.ok(perCall < 50, `${perCall}ms`);
});

test('failed extraction yields the Can’t read this page state', async () => {
  const res = await runCase(manifest.cases.find((c) => c.name === 'no-sizes'));
  const rec = run(res.product, {});
  assert.equal(rec.state, 'failed');
  assert.match(rec.reason, /options/);
});

test('the badge judges the picked size even when the best size is only a risky fit', () => {
  const p = jacket();
  p.sizes.options.forEach((o) => { o.selected = o.label === 'XS'; });
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'outerwear', label: 'M', system: 'alpha' }]);
  const rec = run(p, prof);
  assert.equal(rec.state, 'sizeChange');
  assert.match(rec.verdict, /^Size up/);
});

test('fit numbers always come with words', async () => {
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'bottom', label: '29', system: 'waist' }]);
  const rec = run(await product('next-jeans'), prof);
  assert.equal(rec.fitLabel, 'Great fit');
});

test('a model confidence override replaces the rules number and is recorded', async () => {
  const prof = profileWith([{ type: 'setUsualSize', section: 'men', category: 'bottom', label: '29', system: 'waist' }]);
  const p = await product('next-jeans');
  const rules = run(p, prof);
  const rec = run(p, prof, { confidenceOverride: { confidence: 20, model: 'test-model' } });
  assert.equal(rec.confidence, 20);
  assert.equal(rec.state, 'lowConfidence');
  assert.equal(rec.why.confidenceSource.kind, 'model');
  assert.equal(rec.why.confidenceSource.rules, rules.confidence);
  assert.ok(!/"29"/.test(JSON.stringify(rec.evidence)), 'evidence sent to a model carries no sizes');
});

test('the popup view turns a recommendation into its card title and subtitle', () => {
  assert.deepEqual(
    { ...popupView({ state: 'goodBuy', size: 'M', fit: 88, fitLabel: 'Great fit', verdict: 'Good buy · M' }) },
    { state: 'goodBuy', size: 'M', title: 'Good buy', sub: 'Great fit · 88/100 for you', reason: '', personalized: false, confidenceLabel: null, alert: null, ask: null },
  );
  assert.equal(popupView({ state: 'lowConfidence' }).title, 'No fit data yet');
  assert.equal(popupView({ state: 'sizeChange', verdict: 'Size down to S', selected: 'M' }).sub, 'Better than the M you picked');
});
