'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../extension/ui/logos.js').FitKit.logos;

test('the setup brands find a bundled logo by name or host', () => {
  assert.equal(L.find({}, 'Levi’s'), '/ui/brands/levi.png');
  assert.equal(L.find({}, 'H&M'), '/ui/brands/hm.svg');
  assert.equal(L.find({}, 'Abercrombie & Fitch'), '/ui/brands/abercrombie.png');
  assert.equal(L.find({}, 'www.gap.com'), '/ui/brands/gap.svg');
});

test('a bundled logo wins over a remembered tab icon', () => {
  assert.equal(L.find({ 'uniqlo.com': 'https://uniqlo.com/favicon.ico' }, 'Uniqlo'), '/ui/brands/uniqlo.png');
});

test('other brands still use the remembered icon, or none', () => {
  assert.equal(L.find({ 'madewell.com': 'https://madewell.com/icon.png' }, 'Madewell'), 'https://madewell.com/icon.png');
  assert.equal(L.find({}, 'Madewell'), null);
});

test('every bundled logo file exists', () => {
  for (const brand of ['Uniqlo', 'Levi’s', 'Zara', 'H&M', 'Nike', 'Gap', 'Everlane', 'Abercrombie & Fitch', 'American Eagle', 'PacSun']) {
    const url = L.find({}, brand);
    assert.ok(fs.existsSync(path.join(__dirname, '../extension', url)), `${brand}: ${url}`);
  }
});

test('stores whose website is not their name still find their logo', () => {
  assert.equal(L.find({}, 'ae.com'), '/ui/brands/americaneagle.png');
  assert.equal(L.find({}, 'American Eagle'), '/ui/brands/americaneagle.png');
  assert.equal(L.find({}, 'pacsun.com'), '/ui/brands/pacsun.png');
  assert.equal(L.find({}, 'www2.hm.com'), '/ui/brands/hm.svg');
  assert.equal(L.find({}, 'Aeropostale'), null);
});
