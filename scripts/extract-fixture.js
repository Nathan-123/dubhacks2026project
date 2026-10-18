#!/usr/bin/env node
/*
 * Run the real extractor on a saved page, no browser needed.
 *
 *   node scripts/extract-fixture.js fixtures/pages/shopify-tee.html https://store.com/products/x [shopify.json]
 *   node scripts/extract-fixture.js --case shopify-tee        (uses fixtures/manifest.json)
 *   add --score to also print the rung-0 recommendation
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseHTML, DOMParser } = require('linkedom');
const extract = require('../extension/lib/extract.js');
const score = require('../extension/lib/score.js');

const ROOT = path.join(__dirname, '..');

async function runCase({ page, url, shopify }) {
  const html = fs.readFileSync(path.resolve(ROOT, page), 'utf8');
  const { document } = parseHTML(html);
  const stub = shopify ? JSON.parse(fs.readFileSync(path.resolve(ROOT, shopify), 'utf8')) : null;
  return extract.extract(document, {
    url,
    now: '2026-10-17T22:10:00.000Z',
    fetchJson: async () => stub,
    parseHtml: (s) => new DOMParser().parseFromString(`<!doctype html><html><body>${s}</body></html>`, 'text/html'),
  });
}

module.exports = { runCase };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const wantScore = args.includes('--score');
    const rest = args.filter((a) => a !== '--score');
    let c;
    if (rest[0] === '--case') {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/manifest.json'), 'utf8'));
      c = manifest.cases.find((x) => x.name === rest[1]);
      if (!c) throw new Error(`no case ${rest[1]}`);
    } else {
      c = { page: rest[0], url: rest[1], shopify: rest[2] };
    }
    const res = await runCase(c);
    console.log(JSON.stringify(res, null, 2));
    if (wantScore && res.ok) console.log(JSON.stringify(score.score(res.product, {}), null, 2));
  })().catch((e) => { console.error(e); process.exit(1); });
}
