'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');

const reviews = require('../extension/lib/reviews.js');
const extract = require('../extension/lib/extract.js');

const ROOT = path.join(__dirname, '..');
const yotpoEverlane = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/reviews/yotpo-everlane.json'), 'utf8'));

const STORE_KEY = 'LvSbZbt3mCWwgSn99pNjBNCmx0NLnT99S6DBzvKH';
const YOTPO_URL = `https://api-cdn.yotpo.com/v3/storefront/store/${STORE_KEY}/product/7648929939542/reviews?page=1&perPage=100`;

/** A product page carrying a Yotpo v3 widget, the way Everlane renders it before the widget loads. */
function yotpoPage(widget) {
  return parseHTML(`<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', name: 'The Cloud Cable Cardigan', brand: { '@type': 'Brand', name: 'Everlane' },
      hasVariant: ['XS', 'S', 'M', 'L'].map((size) => ({ '@type': 'Product', size, offers: { availability: 'InStock' } })),
    })}</script>
    <script src="https://cdn-widgetsrepository.yotpo.com/v1/loader/${STORE_KEY}" async></script>
    </head><body><h1>The Cloud Cable Cardigan</h1>
    ${widget === undefined ? '<div class="yotpo-widget-instance" data-yotpo-instance-id="1086873" data-yotpo-product-id="7648929939542"></div>' : widget}
    </body></html>`).document;
}

/** fetchJson stub that answers one URL and records every request. */
function stubFetch(answers) {
  const calls = [];
  const fetchJson = async (url) => { calls.push(url); if (url in answers) return answers[url]; throw new Error(`unexpected fetch ${url}`); };
  return { fetchJson, calls };
}

test('yotpo: reads fit distribution and per-reviewer facts from the storefront API', async () => {
  const { fetchJson, calls } = stubFetch({ [YOTPO_URL]: yotpoEverlane });
  const out = await reviews.read(yotpoPage(), fetchJson);

  assert.deepEqual(calls, [YOTPO_URL]);
  assert.equal(out.platform, 'yotpo');
  // 41 of 48 reviews answered the Fit question: 24 true to size (2), 17 runs large (3).
  assert.equal(out.fit.n, 41);
  assert.deepEqual(out.fit.distribution, { runsSmall: 0, trueToSize: +(24 / 41).toFixed(2), runsLarge: +(17 / 41).toFixed(2) });
  assert.equal(out.fit.aggregate, null, 'per-review answers beat the rounded bottomline average');

  const sized = out.fit.reviewers.find((r) => r.sizeBought === 'Small' && r.usualSize === 'Medium');
  assert.ok(sized, 'keeps size bought next to the reviewer\'s usual size');
  assert.ok(out.fit.reviewers.some((r) => r.heightCm === 180), "height band 5'10-6'0 becomes its midpoint");
  assert.ok(out.fit.reviewers.every((r) => ['small', 'perfect', 'large', null].includes(r.fitVerdict)));
});

test('yotpo: a size answer that is not a size label is dropped, not guessed', async () => {
  const { fetchJson } = stubFetch({ [YOTPO_URL]: yotpoEverlane });
  const out = await reviews.read(yotpoPage(), fetchJson);
  assert.ok(!out.fit.reviewers.some((r) => /purchased/i.test(r.sizeBought || '')));
});

test('yotpo: never carries review text, titles or reviewer names', async () => {
  const withText = structuredClone(yotpoEverlane);
  withText.reviews.forEach((r) => Object.assign(r, { title: 'SECRET TITLE', content: 'SECRET BODY', user: { displayName: 'SECRET NAME' } }));
  const { fetchJson } = stubFetch({ [YOTPO_URL]: withText });
  const out = await reviews.read(yotpoPage(), fetchJson);
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
});

test('yotpo: falls back to the bottomline fit score when no review answered the fit question', async () => {
  const noAnswers = { ...yotpoEverlane, reviews: [] };
  const { fetchJson } = stubFetch({ [YOTPO_URL]: noAnswers });
  const out = await reviews.read(yotpoPage(), fetchJson);
  assert.equal(out.fit.distribution, null);
  assert.deepEqual(out.fit.aggregate, { scale: 0, label: 'true to size', n: 48, source: 'yotpo' });
});

test('pages without a known review platform make no request', async () => {
  const { fetchJson, calls } = stubFetch({});
  assert.equal(await reviews.read(yotpoPage(''), fetchJson), null);
  assert.deepEqual(calls, []);
});

test('an unusable API answer reads as no data', async () => {
  for (const answer of [null, { error: 'nope' }, { reviews: 'x' }]) {
    const { fetchJson } = stubFetch({ [YOTPO_URL]: answer });
    assert.equal(await reviews.read(yotpoPage(), fetchJson), null);
  }
});

test('extract: review API facts fill reviewFit with reviewApi provenance', async () => {
  const { fetchJson } = stubFetch({ [YOTPO_URL]: yotpoEverlane });
  const res = await extract.extract(yotpoPage(), { url: 'https://www.everlane.com/products/womens-cloud-cable-cardigan-heather-charcoal', fetchJson });
  assert.equal(res.ok, true);
  assert.equal(res.reviewPlatform, 'yotpo');
  assert.equal(res.tiers.reviewApi > 0, true);
  assert.equal(res.product._src['reviewFit.distribution'], 'reviewApi');
  assert.equal(res.product._src['reviewFit.reviewers'], 'reviewApi');
  assert.equal(res.product.reviewFit.n, 41);
});

test('extract: a failing review API is reported in tiers and extraction still succeeds', async () => {
  const fetchJson = async () => { throw new Error('blocked by CORS'); };
  const res = await extract.extract(yotpoPage(), { url: 'https://www.everlane.com/products/womens-cloud-cable-cardigan-heather-charcoal', fetchJson });
  assert.equal(res.ok, true);
  assert.equal(res.tiers.reviewApi, 'error: blocked by CORS');
  assert.equal(res.product.reviewFit.distribution, null);
});
