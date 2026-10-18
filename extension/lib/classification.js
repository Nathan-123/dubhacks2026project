/* Shared clothing rules, independent of page reading and browser APIs. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).classification = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORY_WORDS = [
    ['outerwear', /\b(jacket|coat|parka|blazer|puffer|trench|anorak|windbreaker|gilet|vest)\b/i],
    ['dress', /\b(dress|jumpsuit|romper|gown)\b/i],
    ['bottom', /\b(jeans?|pants?|trousers?|shorts|skirt|chinos?|leggings|joggers?|sweatpants|denim)\b/i],
    ['shoes', /\b(shoes?|sneakers?|boots?|sandals?|loafers?|heels|trainers|slides)\b/i],
    ['top', /\b(t-?shirt|tee|shirt|blouse|sweater|hoodie|sweatshirt|polo|tank|cardigan|top|crewneck|knit|pullover|henley|camisole|turtleneck)\b/i],
  ];

  function categorize(text) {
    for (const [cat, re] of CATEGORY_WORDS) {
      const m = String(text || '').match(re);
      if (m) {
        let sub = m[1].toLowerCase().replace(/^tee$/, 't-shirt').replace(/^tshirt$/, 't-shirt');
        if (cat === 'bottom') sub = sub.replace(/^(jean|pant|trouser|chino|jogger)$/, '$1s');
        else if (sub !== 'dress') sub = sub.replace(/s$/, '');
        return { category: cat, subcategory: sub };
      }
    }
    return null;
  }

  function sectionOf(text) {
    const s = String(text || '').toLowerCase();
    if (/(^|[\/\s_-])(women|womens|woman|ladies)([\/\s_'-]|$)/.test(s)) return 'women';
    if (/(^|[\/\s_-])(men|mens|man)([\/\s_'-]|$)/.test(s)) return 'men';
    if (/(^|[\/\s_-])unisex([\/\s_-]|$)/.test(s)) return 'unisex';
    return null;
  }

  return { categorize, sectionOf };
});
