'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../extension/lib/profile.js');

const run = (...events) => events.reduce((p, e) => P.apply(p, { at: '2026-10-17T12:00:00Z', ...e }), P.emptyProfile());

test('onboarding answers are stored once and marked complete', () => {
  const p = run(
    { type: 'setSection', section: 'women' },
    { type: 'setBody', body: { heightCm: 165, weightKg: null } },
    { type: 'setPreference', preference: 'oversized' },
    { type: 'completeOnboarding' },
  );
  assert.equal(p.section, 'women');
  assert.deepEqual(p.body, { heightCm: 165, weightKg: null });
  assert.equal(p.preference, 'oversized');
  assert.equal(p.onboardedAt, '2026-10-17T12:00:00Z');
});

test('each best-fitting piece becomes a wardrobe item that fit well', () => {
  const p = run({ type: 'setAnchorItems', items: [
    { brand: 'Uniqlo', category: 'top', section: 'men', size: 'L', system: 'alpha' },
    { brand: 'Uniqlo', category: 'bottom', section: 'men', size: '32x30', system: 'waistInseam' },
    { brand: "Levi's", category: 'bottom', section: 'men', size: '32', system: 'waist' },
  ] });
  assert.deepEqual(p.wardrobe.map((w) => [w.brand, w.category, w.size]), [
    ['Uniqlo', 'top', 'L'], ['Uniqlo', 'bottom', '32x30'], ["Levi's", 'bottom', '32'],
  ]);
  assert.ok(p.wardrobe.every((w) => w.feedback === 'perfect' && w.source === 'onboarding'));
  assert.equal(P.anchorItems(p).length, 3);
});

test('saving setup again replaces the best-fitting pieces instead of adding more', () => {
  const p = run(
    { type: 'addItem', item: { brand: 'Gap', category: 'top', size: 'L' } },
    { type: 'setAnchorItems', items: [{ brand: 'Uniqlo', category: 'top', size: 'M' }, { brand: 'Zara', category: 'top', size: 'S' }] },
    { type: 'setAnchorItems', items: [{ brand: "Levi's", category: 'bottom', size: '32' }] },
  );
  assert.deepEqual(p.wardrobe.map((w) => w.brand), ['Gap', "Levi's"]);
});

test('clearing the best-fitting pieces removes only those items', () => {
  const p = run(
    { type: 'addItem', item: { brand: 'Gap', category: 'top', size: 'L' } },
    { type: 'setAnchorItems', items: [{ brand: 'Uniqlo', category: 'top', size: 'M' }] },
    { type: 'setAnchorItems', items: [] },
  );
  assert.deepEqual(p.wardrobe.map((w) => w.brand), ['Gap']);
  assert.deepEqual(P.anchorItems(p), []);
});

test('older profiles without onboarding fields still load', () => {
  const p = P.apply({ version: 1, stated: {}, wardrobe: [] }, { type: 'setSection', section: 'men' });
  assert.equal(p.section, 'men');
  assert.deepEqual(P.anchorItems(p), []);
});

test('brand sizes are kept per kind of piece, never one size per brand', () => {
  const wardrobe = [
    { brand: 'Levi’s', category: 'bottom', subcategory: 'jeans', size: '32x32', feedback: 'perfect', date: '2026-09-01' },
    { brand: 'Levi’s', category: 'top', size: 'M', feedback: 'perfect', date: '2026-08-01' },
    { brand: 'levi’s ', category: 'outerwear', size: 'L', date: '2026-07-01' },
  ];
  assert.deepEqual(P.brandSizes({ wardrobe }), [{
    brand: 'Levi’s',
    pieces: [
      { kind: 'bottom', size: '32x32', feedback: 'perfect' },
      { kind: 'top', size: 'M', feedback: 'perfect' },
      { kind: 'outerwear', size: 'L', feedback: null },
    ],
  }]);
});

test('within one kind, the piece that fit wins over a newer one that did not', () => {
  const wardrobe = [
    { brand: 'Gap', category: 'top', size: 'L', feedback: 'large', date: '2026-10-01' },
    { brand: 'Gap', category: 'top', size: 'M', feedback: 'perfect', date: '2026-06-01' },
    { brand: 'Gap', category: 'top', size: 'S', date: '2026-05-01' },
  ];
  assert.deepEqual(P.brandSizes({ wardrobe })[0].pieces, [{ kind: 'top', size: 'M', feedback: 'perfect' }]);
});

test('brands are ordered by their newest piece and pieces without a brand are skipped', () => {
  const wardrobe = [
    { brand: 'Zara', category: 'top', size: 'S', date: '2026-01-01' },
    { brand: '', category: 'top', size: 'M', date: '2026-10-01' },
    { brand: 'Nike', category: 'shoes', size: '10', date: '2026-09-01' },
  ];
  assert.deepEqual(P.brandSizes({ wardrobe }).map((b) => b.brand), ['Nike', 'Zara']);
});

const STORES = [
  { host: 'uniqlo.com', name: 'Uniqlo', returns: { days: 30, url: 'https://faq-us.uniqlo.com/returns' } },
  { host: 'www2.hm.com', name: 'H&M', returns: { days: 30, url: 'https://www2.hm.com/returns' } },
  { host: 'pacsun.com', name: 'PacSun' },
];
const NOW = new Date('2026-10-18T12:00:00').getTime();

test('a piece from a curated store counts down its real return window and cites the policy', () => {
  const r = P.returnWindow({ brand: 'Uniqlo', date: '2026-10-08' }, STORES, NOW);
  assert.deepEqual(r, { daysLeft: 20, store: 'Uniqlo', url: 'https://faq-us.uniqlo.com/returns' });
  assert.equal(P.returnWindow({ brand: 'h&m', date: '2026-10-08' }, STORES, NOW).store, 'H&M');
});

test('other stores fall back to the default window with no source to cite', () => {
  const r = P.returnWindow({ brand: 'PacSun', date: '2026-10-08', returnBy: '2026-11-07' }, STORES, NOW);
  assert.deepEqual(r, { daysLeft: 20, store: null, url: null });
  assert.equal(P.returnWindow({ brand: 'Madewell' }, STORES, NOW), null);
});

test('a piece from an order matches its store by website, and the first known policy wins', () => {
  const learned = [{ host: 'uniqlo.com', name: null, returns: { days: 45, url: 'https://www.uniqlo.com/returns' } }];
  const r = P.returnWindow({ brand: 'Uniqlo', host: 'uniqlo.com', date: '2026-10-08' }, [...learned, ...STORES], NOW);
  assert.deepEqual(r, { daysLeft: 35, store: 'uniqlo.com', url: 'https://www.uniqlo.com/returns' });
  assert.equal(P.returnWindow({ brand: 'Some Label', host: 'shop.pacsun.com', date: '2026-10-08' },
    [{ host: 'pacsun.com', name: 'PacSun', returns: { days: 30, url: 'u' } }], NOW).store, 'PacSun');
});
