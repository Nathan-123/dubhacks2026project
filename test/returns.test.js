'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const R = require('../extension/lib/returns.js');

const page = (body) => parseHTML(`<html><body>${body}</body></html>`).document;

test('the store’s own return policy link is found, and links to other sites are ignored', () => {
  const doc = page(`
    <a href="https://help.other.com/returns">Returns</a>
    <a href="/help/shipping">Shipping</a>
    <footer><a href="/customer-service/returns.html">Returns &amp; Exchanges</a></footer>`);
  assert.equal(R.policyLink(doc, 'https://www2.hm.com/en_us/p/1'), 'https://www2.hm.com/customer-service/returns.html');
  assert.equal(R.policyLink(page('<a href="/about">About</a>'), 'https://x.com/p'), null);
});

test('a help-centre subdomain of the same store still counts as the store', () => {
  const doc = page('<a href="https://faq-us.uniqlo.com/articles/return-policy">Return Policy</a>');
  assert.equal(R.policyLink(doc, 'https://www.uniqlo.com/us/en/products/1'), 'https://faq-us.uniqlo.com/articles/return-policy');
});

test('the return window and what it counts from are read from plain policy wording', () => {
  assert.deepEqual(R.readWindow('Online returns must be postmarked within 30 days of the delivery date.'),
    { days: 30, from: 'delivery', sure: true });
  assert.deepEqual(R.readWindow('You may return items within 45 days of shipment. Refunds take 5-7 business days.'),
    { days: 45, from: 'shipping', sure: true });
  assert.deepEqual(R.readWindow('We accept returns up to 60 days after purchase.'), { days: 60, from: 'purchase', sure: true });
});

test('conflicting windows are not guessed; no window at all is null', () => {
  const r = R.readWindow('Return within 30 days of delivery. Holiday purchases can be returned within 60 days.');
  assert.equal(r.sure, false);
  assert.equal(R.readWindow('Free shipping on orders over $50. Delivery in 5 days.'), null);
});
