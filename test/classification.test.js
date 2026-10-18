'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicParse } = require('../server/orders.js');

test('order classification preserves category priority, plural normalization and sections', () => {
  const names = ['Women jacket shirt', 'men jean', 'unisex sneakers', 'ladies dress', 'mystery accessory'];
  const items = heuristicParse(names.map((name) => ({ name, size: 'M', price: null })), 'Store');
  assert.deepEqual(items.map(({ category, subcategory, section }) => [category, subcategory, section]), [
    ['outerwear', 'jacket', 'women'], ['bottom', 'jeans', 'men'], ['shoes', 'sneaker', 'unisex'],
    ['dress', 'dress', 'women'], [null, null, null],
  ]);
});
