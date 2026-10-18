'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sizes = require('../extension/lib/sizes.js');

test('letter sizes are spelled out for shoppers', () => {
  assert.deepEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL'].map(sizes.spelledOut),
    ['Extra small', 'Small', 'Medium', 'Large', 'Extra large', '2X large', '2X large']);
});

test('waist by length reads with a times sign, and other sizes stay as they are', () => {
  assert.equal(sizes.spelledOut('32x30'), '32 × 30');
  assert.equal(sizes.spelledOut('32'), '32');
  assert.equal(sizes.spelledOut('10.5'), '10.5');
  assert.equal(sizes.spelledOut(null), '');
});
