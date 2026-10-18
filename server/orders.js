/*
 * orders — heuristic normalization of order-confirmation line items (the LLM tier refines
 * brand/category when available). Input is already reduced to { name, size, price }.
 */
'use strict';

const sizes = require('../extension/lib/sizes.js');
const classification = require('../extension/lib/classification.js');

const PII = /(@|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b|\b(?:\d[ -]?){13,19}\b|\b\d+\s+\w+\s+(street|st|avenue|ave|road|rd|blvd|lane|ln|drive|dr|way|court|ct)\b|\b(visa|mastercard|amex|ending\s*in)\b)/i;

function scrubItem(it) {
  if (!it || typeof it !== 'object') return null;
  const name = String(it.name || '').slice(0, 120);
  const size = String(it.size || '').slice(0, 12);
  if (!name || !size || PII.test(name) || PII.test(size)) return null;
  const price = typeof it.price === 'number' && isFinite(it.price) ? it.price : null;
  return { name, size, price };
}

function heuristicParse(items, brand) {
  return items.map((it) => {
    const cat = classification.categorize(it.name) || {};
    const section = classification.sectionOf(it.name);
    const p = sizes.parseLabel(it.size);
    return {
      name: it.name, size: p ? p.label : it.size, price: it.price,
      brand: brand || null, category: cat.category || null, subcategory: cat.subcategory || null, section: section || null,
    };
  });
}

module.exports = { scrubItem, heuristicParse };
