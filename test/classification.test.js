'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicParse } = require('../server/orders.js');
const extract = require('../extension/lib/extract.js');
const { parseHTML } = require('linkedom');

test('order classification preserves category priority, plural normalization and sections', () => {
  const names = ['Women jacket shirt', 'men jean', 'unisex sneakers', 'ladies dress', 'mystery accessory'];
  const items = heuristicParse(names.map((name) => ({ name, size: 'M', price: null })), 'Store');
  assert.deepEqual(items.map(({ category, subcategory, section }) => [category, subcategory, section]), [
    ['outerwear', 'jacket', 'women'], ['bottom', 'jeans', 'men'], ['shoes', 'sneaker', 'unisex'],
    ['dress', 'dress', 'women'], [null, null, null],
  ]);
});

test('extractor review lookup returns the region element or null', () => {
  const { document } = parseHTML('<html><body><div id="reviews">Fit reviews</div></body></html>');
  assert.equal(extract.findReviewRegion(document, { reviewContainer: '#reviews' }), document.querySelector('#reviews'));
  assert.equal(extract.findReviewRegion(parseHTML('<html><body></body></html>').document, {}), null);
});
