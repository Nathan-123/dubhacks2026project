/*
 * sizes — size-label parsing and the "size step" model.
 *
 * Every size label is mapped to a numeric rank within its system. Ranks are only
 * compared inside one system; there is no cross-system conversion in v1.
 * One step = moving to the adjacent distinct rank in this garment's own option list.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).sizes = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALPHA_RANK = {
    XXXS: 0, XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6, XXL: 7, XXXL: 8, XXXXL: 9, XXXXXL: 10,
    // Plus "X" sizes, treated as ordinal continuation of the alpha scale.
    '0X': 6, '1X': 7, '2X': 8, '3X': 9, '4X': 10, '5X': 11,
  };

  const ALPHA_WORDS = [
    [/^(extra[\s-]*extra[\s-]*small|xx[\s-]*small)$/i, 'XXS'],
    [/^(extra[\s-]*small|x[\s-]*small)$/i, 'XS'],
    [/^small$/i, 'S'],
    [/^medium$/i, 'M'],
    [/^large$/i, 'L'],
    [/^(extra[\s-]*large|x[\s-]*large)$/i, 'XL'],
    [/^(extra[\s-]*extra[\s-]*large|xx[\s-]*large)$/i, 'XXL'],
  ];

  const LENGTH_SUFFIX = /\s*[-(]?\s*(petite|tall|short|long|regular|reg)\s*\)?$/i;
  const ONE_SIZE = /^(one[\s-]*size(\s*fits\s*(all|most))?|os|o\/s|osfa|no\s*size)$/i;

  /** Canonical alpha label (e.g. "X-Large" -> "XL", "2XL" -> "XXL"), or null. */
  function normalizeAlpha(raw) {
    let s = String(raw).trim();
    for (const [re, label] of ALPHA_WORDS) if (re.test(s)) return label;
    s = s.toUpperCase().replace(/[\s.-]/g, '');
    const nx = s.match(/^([2-5])XL$/); // 2XL..5XL
    if (nx) return 'X'.repeat(Number(nx[1])) + 'L';
    const ns = s.match(/^([2-3])XS$/);
    if (ns) return 'X'.repeat(Number(ns[1])) + 'S';
    if (ALPHA_RANK[s] !== undefined) return s;
    return null;
  }

  /**
   * Parse one label. Returns { system, rank, label, length, inseam } or null when the
   * text does not look like a size at all (used to reject "Add to bag" etc.).
   */
  function parseLabel(raw) {
    if (raw == null) return null;
    let text = String(raw).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 24) return null;
    text = text.replace(/^size[:\s]*/i, '');
    if (ONE_SIZE.test(text)) return { system: 'onesize', rank: 0, label: text };

    let length = null;
    const lm = text.match(LENGTH_SUFFIX);
    if (lm && lm.index > 0) { length = lm[1].toLowerCase(); text = text.slice(0, lm.index).trim(); }

    // Split alpha like "S/M" or "M-L": rank is the midpoint.
    const split = text.match(/^([A-Za-z0-9]{1,4})\s*[\/-]\s*([A-Za-z0-9]{1,4})$/);
    if (split) {
      const a = normalizeAlpha(split[1]);
      const b = normalizeAlpha(split[2]);
      if (a && b) return { system: 'alpha', rank: (ALPHA_RANK[a] + ALPHA_RANK[b]) / 2, label: `${a}/${b}`, length };
    }

    const alpha = normalizeAlpha(text);
    if (alpha) return { system: 'alpha', rank: ALPHA_RANK[alpha], label: alpha, length };

    const wi = text.match(/^W?\s*(\d{2})\s*(?:[x×\/]|\s*L)\s*(\d{2})$/i);
    if (wi) return { system: 'waistInseam', rank: Number(wi[1]), label: `${wi[1]}x${wi[2]}`, inseam: Number(wi[2]), length };

    const eu = text.match(/^(?:EU|FR|IT)\s*(\d{2}(?:\.5)?)$/i);
    if (eu) return { system: 'eu', rank: Number(eu[1]), label: `EU ${eu[1]}`, length };

    const uk = text.match(/^UK\s*(\d{1,2}(?:\.5)?)$/i);
    if (uk) return { system: 'uk', rank: Number(uk[1]), label: `UK ${uk[1]}`, length };

    const us = text.match(/^US\s*(\d{1,2}(?:\.5)?)$/i);
    if (us) return { system: 'numeric', rank: Number(us[1]), label: us[1], length };

    const num = text.match(/^(00|\d{1,2}(?:\.5)?)$/);
    if (num) return { system: 'numeric', rank: num[1] === '00' ? -2 : Number(num[1]), label: num[1], length };

    return null;
  }

  /** The dominant system across a list of labels. */
  function detectSystem(labels) {
    const counts = {};
    let parsed = 0;
    for (const l of labels) {
      const p = parseLabel(l);
      if (!p) continue;
      parsed++;
      counts[p.system] = (counts[p.system] || 0) + 1;
    }
    if (!parsed) return 'unknown';
    // A numeric list where every value is a plausible jeans waist reads as waist sizing.
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    if (best === 'numeric') {
      const nums = labels.map(parseLabel).filter(Boolean).map((p) => p.rank);
      if (nums.length && nums.every((n) => n >= 23 && n <= 44 && Number.isInteger(n))) return 'waist';
    }
    return best;
  }

  /** Systems that can be compared rank-to-rank. "waist" and "numeric" are both plain numbers. */
  function sameFamily(a, b) {
    if (a === b) return true;
    const num = new Set(['numeric', 'waist', 'waistInseam']);
    return num.has(a) && num.has(b);
  }

  /**
   * Build the step ladder for a garment: unique ranks sorted ascending, each rung holding
   * its options. Unparseable labels keep their page order as an ordinal rank.
   */
  function ladder(options) {
    const rungs = new Map();
    options.forEach((opt, i) => {
      const p = parseLabel(opt.label);
      const rank = p ? p.rank : 1000 + i;
      if (!rungs.has(rank)) rungs.set(rank, { rank, options: [] });
      rungs.get(rank).options.push({ ...opt, parsed: p });
    });
    return [...rungs.values()].sort((a, b) => a.rank - b.rank);
  }

  /**
   * Fractional position of a rank on a ladder. Between two rungs it interpolates;
   * outside the range it extrapolates using the average rung spacing, so a user whose
   * size the brand does not make lands off the end (and scores low) instead of being
   * silently clamped to the nearest size.
   */
  function positionOf(rank, rungs) {
    if (!rungs.length) return null;
    const ranks = rungs.map((r) => r.rank);
    if (rungs.length === 1) return rank === ranks[0] ? 0 : (rank < ranks[0] ? -1 : 1);
    const spacing = (ranks[ranks.length - 1] - ranks[0]) / (ranks.length - 1) || 1;
    if (rank <= ranks[0]) return (rank - ranks[0]) / spacing;
    if (rank >= ranks[ranks.length - 1]) return ranks.length - 1 + (rank - ranks[ranks.length - 1]) / spacing;
    for (let i = 0; i < ranks.length - 1; i++) {
      if (rank >= ranks[i] && rank <= ranks[i + 1]) return i + (rank - ranks[i]) / (ranks[i + 1] - ranks[i]);
    }
    return null;
  }

  function isSizeLabel(text) {
    return parseLabel(text) !== null;
  }

  const SPELLED = {
    XXXS: '3X small', XXS: '2X small', XS: 'Extra small', S: 'Small', M: 'Medium', L: 'Large',
    XL: 'Extra large', XXL: '2X large', XXXL: '3X large', XXXXL: '4X large', XXXXXL: '5X large',
  };

  /** A size as a shopper says it: "M" -> "Medium", "32x30" -> "32 × 30"; anything else unchanged. */
  function spelledOut(label) {
    const s = String(label == null ? '' : label).trim();
    const alpha = normalizeAlpha(s);
    if (alpha && SPELLED[alpha]) return SPELLED[alpha];
    return s.replace(/^(\d+)\s*x\s*(\d+)$/i, '$1 \u00d7 $2');
  }

  return { parseLabel, normalizeAlpha, spelledOut, detectSystem, sameFamily, ladder, positionOf, isSizeLabel, ALPHA_RANK };
});
