'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { architectureErrors } = require('../scripts/check.js');

test('production cannot consume extractor diagnostics through dot or bracket access', () => {
  for (const source of ['K.extract._internal.categorize(name)', "extract['_internal'].sectionOf(name)"]) {
    assert.equal(architectureErrors('server/orders.js', source).length, 1);
    assert.equal(architectureErrors('probe/probe-report.js', source).length, 0);
  }
  assert.deepEqual(architectureErrors('extension/lib/extract.js', 'return { _internal: { classify } };'), []);
  assert.deepEqual(architectureErrors('server/orders.js', 'classification.categorize(name)'), []);
});

test('classification cannot depend on DOM, browser, network or imported modules', () => {
  for (const source of [
    'document.querySelector("h1")', 'window.location', 'chrome.runtime', 'fetch(url)',
    'new XMLHttpRequest()', 'new WebSocket(url)', 'navigator.sendBeacon(url)',
    'require("./extract.js")', 'importScripts("extract.js")', 'import("./extract.js")',
  ]) {
    assert.equal(architectureErrors('extension/lib/classification.js', source).length, 1, source);
  }
  assert.deepEqual(architectureErrors('extension/lib/classification.js', 'module.exports = { categorize, sectionOf };'), []);
});
