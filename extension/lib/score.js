/*
 * score — (Product, Profile) -> Recommendation.
 *
 * Deterministic arithmetic, no DOM, no network. Everything is in size steps:
 *
 *   recommended = baseline - offset_item + adjust_preference
 *
 * Fit score (how well a size matches) and confidence (how much data backs it) are
 * computed separately. Missing data lowers confidence; it never lowers the fit score.
 * All tunable numbers live in CONFIG so demo-day tuning touches one object.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode
    ? { sizes: require('./sizes.js'), contract: require('./contract.js') }
    : root.FitKit;
  const mod = factory(deps.sizes, deps.contract);
  if (isNode) module.exports = mod;
  else (root.FitKit = root.FitKit || {}).score = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sizes, contract) {
  'use strict';

  const CONFIG = {
    lowConfidence: 40,
    highConfidence: 70,
    goodFit: 80,
    riskFit: 50,
    // Stated size vs wardrobe: wardrobe wins only once this many items agree.
    wardrobeAgreeMin: 2,
    feedbackHalfLifeDays: 180,
    // Offset signal weights (signal priority ranks 4-7).
    weights: { aggregate: 0.6, distribution: 0.6, reviewers: 0.4, cut: 0.25, prior: 0.1 },
    // Weak evidence is shrunk toward zero: offset = sum(w*o) / max(sum(w), shrinkFloor).
    shrinkFloor: 0.6,
    // A clear majority ("62% runs small") should read as a full size step.
    consensusGain: 1.6,
    // A stronger signal present means weaker ones only break ties.
    strongSignal: 0.3,
    // Brand-calibrated baselines already absorb how the brand cuts; dampen the item offset.
    brandCalibratedOffsetDamping: 0.5,
    // Garment-chart vs anchor-item weight when blending into the target position.
    chartWeight: 0.3,
    preferenceAdjust: { fitted: -0.35, regular: 0, relaxed: 0.35 },
    // Minimum offset strength before a rung-0 badge claims anything about the item.
    rung0Strength: 0.3,
  };

  const NEIGHBOR_CATEGORIES = {
    outerwear: ['top'],
    dress: ['top'],
    top: ['outerwear', 'dress'],
    bottom: [],
    shoes: [],
  };

  const CUT_OFFSETS = [
    [/\b(oversized|relaxed|boxy|loose|baggy|roomy)\b/i, 0.5],
    [/\b(slim|skinny|fitted|muscle|cropped|petite fit|body[\s-]?con)\b/i, -0.4],
  ];

  // ---------------------------------------------------------------------------
  // helpers

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const round = (x) => Math.round(x);

  function brandKey(b) {
    return String(b || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  }

  function sameBrand(a, b) {
    const x = brandKey(a), y = brandKey(b);
    if (!x || !y) return false;
    return x === y || x.startsWith(y) || y.startsWith(x);
  }

  /** Rank units per size step in a system (women's numeric 0/2/4 moves by 2). */
  function rankStep(system, rank) {
    if (system === 'numeric' && rank <= 30 && rank % 2 === 0) return 2;
    if (system === 'eu' || system === 'uk') return 2;
    return 1;
  }

  /** Fit score from distance (in steps) to the ideal position. */
  function fitFromDistance(d) {
    const s = 97 - 40 * Math.min(d, 0.5) - 110 * Math.max(0, d - 0.5);
    return round(clamp(s, 3, 97));
  }

  /** Words for a fit score, so the number never has to stand on its own. */
  function fitLabel(score) {
    if (score == null) return null;
    if (score >= 90) return 'Great fit';
    if (score >= CONFIG.goodFit) return 'Good fit';
    if (score >= CONFIG.riskFit) return 'Risky fit';
    return 'Poor fit';
  }

  function shape(s) {
    return Math.sign(s) * Math.min(1, Math.abs(s) * CONFIG.consensusGain);
  }

  function recencyWeight(dateStr, now) {
    if (!dateStr) return 0.5;
    const age = (now - new Date(dateStr).getTime()) / 86400000;
    if (!isFinite(age)) return 0.5;
    return Math.pow(0.5, Math.max(0, age) / CONFIG.feedbackHalfLifeDays);
  }

  // ---------------------------------------------------------------------------
  // item offset (signals 4-7): how does this garment run?

  function computeOffset(product, brandPriors, system) {
    const W = CONFIG.weights;
    const signals = [];
    const rf = product.reviewFit || {};

    if (rf.aggregate && typeof rf.aggregate.scale === 'number') {
      const n = rf.aggregate.n || rf.n || 0;
      signals.push({
        key: 'aggregate', rank: 4,
        steps: shape(rf.aggregate.scale),
        weight: W.aggregate * (n ? clamp(n / 40, 0.15, 1) : 0.3),
        n,
        detail: `${rf.aggregate.label || 'fit score'}${n ? ` (${n} reviews)` : ''}`,
      });
    } else if (rf.distribution) {
      const d = rf.distribution;
      const s = (d.runsLarge || 0) - (d.runsSmall || 0);
      const n = rf.n || 0;
      signals.push({
        key: 'distribution', rank: 4,
        steps: shape(s),
        weight: W.distribution * (n ? clamp(n / 40, 0.15, 1) : 0.3),
        n,
        pctSmall: d.runsSmall, pctTrue: d.trueToSize, pctLarge: d.runsLarge,
        detail: `${round((d.runsSmall || 0) * 100)}% small · ${round((d.trueToSize || 0) * 100)}% true · ${round((d.runsLarge || 0) * 100)}% large`,
      });
    }

    if (Array.isArray(rf.reviewers) && rf.reviewers.length) {
      let small = 0, large = 0, k = 0;
      for (const r of rf.reviewers) {
        const v = String(r.fitVerdict || '').toLowerCase();
        if (!v) continue;
        k++;
        if (/small|tight|snug|short/.test(v)) small++;
        else if (/large|big|loose|long/.test(v)) large++;
      }
      if (k) {
        signals.push({
          key: 'reviewers', rank: 5,
          steps: shape((large - small) / k),
          weight: W.reviewers * clamp(k / 10, 0.1, 1),
          n: k,
          detail: `${k} reviewers listed a fit verdict`,
        });
      }
    }

    // Cut language changes how a garment feels at a given size, but waist-sized bottoms are
    // still bought by waist, so it only shifts the recommendation for non-waist systems.
    const cutText = /waist/i.test(system || '') ? '' : [product.identity.cutHint, product.identity.name].filter(Boolean).join(' ');
    for (const [re, steps] of CUT_OFFSETS) {
      const m = cutText.match(re);
      if (m) { signals.push({ key: 'cut', rank: 6, steps, weight: W.cut, detail: `described as "${m[1].toLowerCase()}"` }); break; }
    }

    const prior = brandPriors && brandPriors[brandKey(product.identity.brand)];
    if (typeof prior === 'number') {
      signals.push({ key: 'prior', rank: 7, steps: prior, weight: W.prior, detail: `${product.identity.brand} brand prior` });
    }

    // Strongest-first: if review evidence is solid, weak signals only nudge.
    const strong = signals.some((s) => s.rank <= 5 && s.weight >= CONFIG.strongSignal);
    if (strong) for (const s of signals) if (s.rank >= 6) s.weight *= 0.5;

    const totalW = signals.reduce((a, s) => a + s.weight, 0);
    const steps = totalW ? signals.reduce((a, s) => a + s.weight * s.steps, 0) / Math.max(totalW, CONFIG.shrinkFloor) : 0;
    const strength = clamp(totalW / CONFIG.shrinkFloor, 0, 1);
    const reviewStrength = clamp(signals.filter((s) => s.rank <= 5).reduce((a, s) => a + s.weight, 0) / CONFIG.shrinkFloor, 0, 1);
    const label = steps <= -0.25 ? 'runs small' : steps >= 0.25 ? 'runs large' : 'true to size';
    return { steps, strength, reviewStrength, label, signals };
  }

  // ---------------------------------------------------------------------------
  // user baseline (signals 1-3): what size is this person?

  function itemRank(item) {
    const p = sizes.parseLabel(item.size);
    return p ? { rank: p.rank, system: p.system, inseam: p.inseam } : null;
  }

  const FEEDBACK_DELTA = { small: 1, perfect: 0, large: -1 };

  /** Effective rank an item implies: an item that was too small means the user is one step up. */
  function effectiveRank(item) {
    const p = itemRank(item);
    if (!p) return null;
    const delta = FEEDBACK_DELTA[item.feedback] || 0;
    return { ...p, rank: p.rank + delta * rankStep(p.system, p.rank) };
  }

  function weightedMean(entries) {
    const w = entries.reduce((a, e) => a + e.w, 0);
    return w ? entries.reduce((a, e) => a + e.w * e.rank, 0) / w : null;
  }

  function baselineForCategory(profile, product, system, section, category, now) {
    const wardrobe = (profile.wardrobe || []).filter((it) => it.category === category && it.size);
    const inSection = (it) => !section || section === 'any' || !it.section || it.section === section;
    const family = (r) => r && sizes.sameFamily(r.system, system);

    // 1. Fit feedback on this brand (strongest).
    const brandFb = wardrobe.filter((it) => inSection(it) && it.feedback && sameBrand(it.brand, product.identity.brand))
      .map((it) => ({ it, r: effectiveRank(it) })).filter((e) => family(e.r));
    if (brandFb.length) {
      const entries = brandFb.map((e) => ({ rank: e.r.rank, w: recencyWeight(e.it.feedbackAt || e.it.date, now) }));
      const ranks = entries.map((e) => e.rank);
      const step = rankStep(system, ranks[0]);
      const recent = brandFb.slice().sort((a, b) => new Date(b.it.feedbackAt || b.it.date) - new Date(a.it.feedbackAt || a.it.date))[0];
      return {
        rank: weightedMean(entries), source: 'feedback', brandCalibrated: true,
        inconsistent: Math.max(...ranks) - Math.min(...ranks) >= step,
        anchor: recent.it, count: brandFb.length,
        inseam: recent.r.inseam,
      };
    }

    // 2. Wardrobe items from this brand, no explicit feedback.
    const brandItems = wardrobe.filter((it) => inSection(it) && !it.returned && sameBrand(it.brand, product.identity.brand))
      .map((it) => ({ it, r: effectiveRank(it) })).filter((e) => family(e.r));
    if (brandItems.length) {
      const entries = brandItems.map((e) => ({ rank: e.r.rank, w: recencyWeight(e.it.date, now) }));
      return { rank: weightedMean(entries), source: 'wardrobe-brand', brandCalibrated: true, anchor: brandItems[0].it, count: brandItems.length, inseam: brandItems[0].r.inseam };
    }

    // 3. Stated usual size, overridden by the wardrobe only when enough items agree.
    const stated = (profile.stated || {})[`${section}:${category}`] || (profile.stated || {})[`any:${category}`];
    const statedRank = stated ? sizes.parseLabel(stated.label) : null;
    const statedOk = statedRank && sizes.sameFamily(stated.system || statedRank.system, system);

    const others = wardrobe.filter((it) => inSection(it) && !it.returned).map((it) => effectiveRank(it)).filter(family);
    const tally = {};
    for (const r of others) tally[r.rank] = (tally[r.rank] || 0) + 1;
    const [modeRank, modeCount] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || [null, 0];

    if (statedOk) {
      if (modeCount >= CONFIG.wardrobeAgreeMin && Number(modeRank) !== statedRank.rank) {
        return { rank: Number(modeRank), source: 'wardrobe', count: modeCount, conflict: { stated: stated.label }, inseam: statedRank.inseam };
      }
      const agree = modeCount >= 1 && Number(modeRank) === statedRank.rank;
      return { rank: statedRank.rank, source: 'stated', label: stated.label, wardrobeAgrees: agree, inseam: statedRank.inseam };
    }
    if (modeCount >= 1) return { rank: Number(modeRank), source: 'wardrobe', count: modeCount };
    return null;
  }

  function resolveBaseline(profile, product, system, now) {
    if (!profile) return null;
    const section = product.identity.section || 'any';
    const category = product.identity.category || 'top';
    let b = baselineForCategory(profile, product, system, section, category, now);
    if (!b && section !== 'any') b = baselineForCategory(profile, product, system, 'any', category, now);
    if (b) return { ...b, category, section };
    for (const near of NEIGHBOR_CATEGORIES[category] || []) {
      const nb = baselineForCategory(profile, product, system, section, near, now);
      if (nb) return { ...nb, category, section, borrowedFrom: near };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // garment chart vs an anchor item the user measured (signal 6)

  function chartPosition(product, profile, rungs) {
    const chart = product.sizeChart;
    const anchor = profile && profile.anchors && profile.anchors[product.identity.category || 'top'];
    if (!chart || chart.kind !== 'garment' || !anchor || !Array.isArray(chart.rows) || !chart.rows.length) return null;
    const toUnit = (v, from) => (from === chart.unit ? v : from === 'cm' ? v / 2.54 : v * 2.54);
    const keys = Object.keys(anchor).filter((k) => typeof anchor[k] === 'number' && chart.rows.some((r) => typeof r[k] === 'number'));
    if (!keys.length) return null;
    let best = null;
    chart.rows.forEach((row) => {
      let err = 0, worst = null;
      for (const k of keys) {
        if (typeof row[k] !== 'number') continue;
        const target = toUnit(anchor[k], anchor.unit || 'in');
        const diff = row[k] - target;
        err += diff * diff;
        if (!worst || Math.abs(diff) > Math.abs(worst.diff)) worst = { key: k, diff };
      }
      if (!best || err < best.err) best = { row, err, worst };
    });
    const p = sizes.parseLabel(best.row.size);
    if (!p) return null;
    const pos = sizes.positionOf(p.rank, rungs);
    return pos == null ? null : { pos, size: best.row.size, marginal: best.worst, unit: chart.unit };
  }

  // ---------------------------------------------------------------------------
  // main

  function failed(missing, product) {
    return {
      state: 'failed', verdict: "Can't read this page", size: null, fit: null,
      confidence: 0, confidenceLabel: 'None',
      reason: `Couldn't find ${(missing || []).map((m) => m.split('.').pop()).join(', ') || 'product details'} on this page.`,
      alert: null, ask: null, scores: [], missing: missing || [],
      helpMost: 'Open the store’s size chart manually',
      product: product ? summary(product) : null,
    };
  }

  function summary(p) {
    return {
      url: p.url, host: p.host, brand: p.identity.brand, name: p.identity.name,
      category: p.identity.category, subcategory: p.identity.subcategory, section: p.identity.section,
      price: p.price, image: p.image,
    };
  }

  function score(product, profile, opts) {
    opts = opts || {};
    const now = opts.now != null ? opts.now : Date.now();
    profile = profile || {};

    const missing = contract.missingFloor(product);
    if (missing.length) return failed(missing, product);

    const options = product.sizes.options;
    const labels = options.map((o) => o.label);
    const system = product.sizes.system || sizes.detectSystem(labels);
    const rungs = sizes.ladder(options);
    const oneSize = system === 'onesize' || rungs.length <= 1;
    const offset = computeOffset(product, opts.brandPriors, system);
    const quality = contract.extractionQuality(product);
    const selectedLabel = opts.selected !== undefined ? opts.selected : (options.find((o) => o.selected) || {}).label || null;
    const askDismissed = !!opts.askDismissed;

    const why = {
      offset: { steps: +offset.steps.toFixed(2), label: offset.label, strength: +offset.strength.toFixed(2), signals: offset.signals },
      baseline: null, chart: null, quality, src: product._src, system,
      modelRef: product.modelRef, fabric: product.fabric,
    };

    const baseline = oneSize ? null : resolveBaseline(profile, product, system, now);
    const askOptions = rungs.map((r) => r.options[0].label);
    const wantAsk = !oneSize && !askDismissed && (!baseline || baseline.borrowedFrom) && system !== 'unknown';
    const ask = wantAsk ? { type: 'usualSize', question: 'What size do you usually buy?', options: askOptions, system, section: product.identity.section || 'any', category: product.identity.category || 'top' } : null;

    // ---- Rung 0: no baseline. Report the item offset honestly, never as personal.
    if (!baseline && !oneSize) {
      const rf = product.reviewFit || {};
      const dist = offset.signals.find((s) => s.key === 'distribution');
      const n = (offset.signals.find((s) => s.rank <= 5) || {}).n || rf.n || 0;
      const conf = round(clamp(offset.reviewStrength * 35, 5, 35));
      const base = {
        size: null, fit: null, fitLabel: null, confidence: conf, confidenceLabel: 'Low', personalized: false, basis: [], caveats: [],
        evidence: { personalized: false, reviewCount: n, itemRuns: offset.label, itemSignalStrength: +offset.strength.toFixed(2) },
        distribution: dist ? { small: dist.pctSmall || 0, true: dist.pctTrue || 0, large: dist.pctLarge || 0, n } : null,
        scores: rungs.map((r) => ({ label: r.options[0].label, score: null, available: r.options.some((o) => o.available !== false) })),
        alert: duplicateAlert(profile, product), ask, why, product: summary(product),
        helpMost: 'Tell us your usual size',
      };
      if (offset.reviewStrength >= CONFIG.rung0Strength && offset.label !== 'true to size') {
        const small = offset.label === 'runs small';
        const pct = dist ? round(((small ? dist.pctSmall : dist.pctLarge) || 0) * 100) : null;
        const evidence = pct != null && n ? `${pct}% of ${n} reviewers said it ${offset.label}` : offset.signals.map((s) => s.detail).join('; ');
        return { ...base, state: small ? 'runsSmall' : 'runsLarge', verdict: small ? 'Runs small' : 'Runs large', reason: `${evidence} — most buyers sized ${small ? 'up' : 'down'}.` };
      }
      if (offset.reviewStrength >= CONFIG.rung0Strength) {
        return { ...base, state: 'trueToSize', verdict: 'True to size', reason: `${n ? `${n} reviews` : 'Available signals'} say this runs true to size.` };
      }
      return { ...base, state: 'lowConfidence', verdict: 'No fit data yet', confidence: 5, reason: 'No fit reviews or size data found for this item. Tell us your usual size and we\u2019ll make a best guess.' };
    }

    // ---- One size: report fit, suppress the size recommendation.
    if (oneSize) {
      return {
        state: offset.label === 'true to size' || offset.strength < CONFIG.rung0Strength ? 'trueToSize' : (offset.label === 'runs small' ? 'runsSmall' : 'runsLarge'),
        verdict: offset.strength < CONFIG.rung0Strength ? 'One size' : offset.label.replace(/^./, (c) => c.toUpperCase()),
        size: labels[0], fit: null, confidence: round(clamp(offset.reviewStrength * 50, 5, 50)), confidenceLabel: 'Low', personalized: false,
        reason: `Only one size is sold${offset.strength >= CONFIG.rung0Strength ? `; reviews say it ${offset.label}` : ''}.`,
        scores: [], alert: duplicateAlert(profile, product), ask: null, why, product: summary(product), helpMost: null,
      };
    }

    // ---- Personalized: combine baseline and offset.
    const basePos = sizes.positionOf(baseline.rank, rungs);
    const effOffset = offset.steps * (baseline.brandCalibrated ? CONFIG.brandCalibratedOffsetDamping : 1);
    const prefAdj = CONFIG.preferenceAdjust[profile.preference] || 0;
    let target = basePos - effOffset + prefAdj;
    const chart = chartPosition(product, profile, rungs);
    if (chart) target = (target * (1 - CONFIG.chartWeight)) + chart.pos * CONFIG.chartWeight;

    const baseLabel = baseline.label || labelForRank(baseline.rank, system, rungs);
    why.baseline = { source: baseline.source, label: baseLabel, position: +basePos.toFixed(2), borrowedFrom: baseline.borrowedFrom || null, brandCalibrated: !!baseline.brandCalibrated, conflict: baseline.conflict || null };
    why.target = +target.toFixed(2);
    why.chart = chart;

    const stretch = !!(product.fabric && product.fabric.stretch);
    const scores = [];
    rungs.forEach((r, i) => {
      const d = Math.abs(i - target);
      for (const o of r.options) {
        let s = fitFromDistance(d);
        if (baseline.inseam && o.parsed && o.parsed.inseam && o.parsed.inseam !== baseline.inseam) s = Math.max(3, s - 15);
        scores.push({ label: o.label, score: s, available: o.available !== false, selected: o.label === selectedLabel, index: i, d });
      }
    });

    // Best overall, ties broken by stretch (smaller) or relaxed preference (larger), else size up.
    const tiebreakLarger = !stretch || profile.preference === 'relaxed';
    const better = (a, b) => (a.score !== b.score ? a.score > b.score : tiebreakLarger ? a.index > b.index : a.index < b.index);
    const pick = (list) => list.reduce((best, s) => (!best || better(s, best) ? s : best), null);
    const best = pick(scores);
    const available = scores.filter((s) => s.available);
    let shown = pick(available) || best; // never recommend something unbuyable
    let runnerUp = pick(available.filter((s) => s.index !== shown.index));
    const between = !!runnerUp && Math.abs(runnerUp.score - shown.score) <= 3 && shown.score < CONFIG.goodFit && Math.abs(runnerUp.index - shown.index) === 1;
    if (between && (tiebreakLarger ? runnerUp.index > shown.index : runnerUp.index < shown.index)) {
      [shown, runnerUp] = [runnerUp, shown];
    }
    const selected = scores.find((s) => s.selected) || null;

    // ---- Confidence: how much data backs it.
    const parts = [];
    const add = (pts, why) => { parts.push({ pts, why }); };
    add({ feedback: 50, 'wardrobe-brand': 34, wardrobe: 32, stated: 30 }[baseline.source] || 25, `baseline from ${baseline.source.replace('-', ' ')}`);
    if (baseline.wardrobeAgrees) add(5, 'wardrobe agrees with your stated size');
    add(round(30 * offset.reviewStrength), 'review evidence');
    if (product.sizeChart && product.sizeChart.rows && product.sizeChart.rows.length) add(product.sizeChart.kind === 'garment' ? 6 : 3, `${product.sizeChart.kind} size chart`);
    if (chart) add(6, 'chart matched to your anchor item');
    if (offset.signals.some((s) => s.key === 'cut')) add(2, 'cut description');
    if (product.fabric) add(2, 'fabric composition');
    if (baseline.borrowedFrom) add(-12, `borrowed your ${baseline.borrowedFrom} size`);
    if (baseline.inconsistent) add(-20, `${product.identity.brand} has fit you inconsistently`);
    if (product.sizeChart && product.sizeChart.imageOnly) add(-4, 'size chart is an image we cannot read');
    if (quality === 'llm') add(-5, 'page read by the fallback reader');
    if (quality === 'floor-only') add(-12, 'only basic page details found');
    // Fairness: review data is thinnest at the ends of a size range.
    const atEdge = target < 0.25 || target > rungs.length - 1.25;
    if (atEdge && offset.reviewStrength < 0.8) add(-10, 'fewer reviews from shoppers at this end of the size range');
    const rulesConfidence = round(clamp(parts.reduce((a, p) => a + p.pts, 0), 5, 98));
    why.confidenceParts = parts;
    const reviewN = (offset.signals.find((s) => s.rank <= 5) || {}).n || (product.reviewFit && product.reviewFit.n) || 0;

    // Compact, non-identifying summary of the evidence. This is all a confidence model sees:
    // no sizes, no brands, no wardrobe contents.
    const evidence = {
      personalized: true,
      baselineSource: baseline.source,
      borrowedFromOtherCategory: !!baseline.borrowedFrom,
      brandFitFeedbackCount: baseline.source === 'feedback' ? baseline.count : 0,
      brandOrdersCount: baseline.source === 'wardrobe-brand' ? baseline.count : 0,
      wardrobeAgreesWithStated: !!baseline.wardrobeAgrees,
      brandFitInconsistent: !!baseline.inconsistent,
      statedVsWardrobeConflict: !!baseline.conflict,
      reviewCount: reviewN,
      reviewSignal: (offset.signals.find((s) => s.rank === 4) || {}).key || null,
      reviewerVerdicts: (offset.signals.find((s) => s.key === 'reviewers') || {}).n || 0,
      itemRuns: offset.label,
      itemSignalStrength: +offset.strength.toFixed(2),
      sizeChart: product.sizeChart ? (product.sizeChart.imageOnly ? 'image-only' : product.sizeChart.kind) : null,
      chartMatchedToReferenceItem: !!chart,
      fabricKnown: !!product.fabric,
      stretchFabric: !!(product.fabric && product.fabric.stretch),
      extractionQuality: quality,
      atEdgeOfSizeRange: atEdge,
      category: product.identity.category || null,
      sizeSystem: system,
      rulesConfidence,
    };

    const ov = opts.confidenceOverride;
    const confidence = ov && typeof ov.confidence === 'number' ? round(clamp(ov.confidence, 5, 98)) : rulesConfidence;
    const confidenceLabel = confidence >= CONFIG.highConfidence ? 'High' : confidence >= CONFIG.lowConfidence ? 'Medium' : 'Low';
    why.confidenceSource = ov && typeof ov.confidence === 'number' ? { kind: 'model', model: ov.model || null, rules: rulesConfidence, note: ov.reason || null } : { kind: 'rules' };

    // What the confidence rests on, in plain words (shown as chips in the card).
    const brand = product.identity.brand || 'this brand';
    const basis = [];
    basis.push({ feedback: `Your ${brand} fit feedback`, 'wardrobe-brand': `Your ${brand} order`, wardrobe: 'Sizes you keep', stated: 'Your usual size' }[baseline.source] || 'Your sizes');
    if (reviewN && offset.reviewStrength >= 0.15) basis.push(`${reviewN} reviews`);
    else if (offset.signals.some((s) => s.key === 'reviewers')) basis.push('Reviewer fit notes');
    if (chart) basis.push('Your reference item');
    else if (product.sizeChart && product.sizeChart.rows && product.sizeChart.rows.length) basis.push(product.sizeChart.kind === 'garment' ? 'Garment measurements' : 'Size chart');
    if (product.fabric && product.fabric.stretch) basis.push('Stretch fabric');
    const caveats = parts.filter((p) => p.pts < 0).map((p) => p.why);

    // ---- State.
    // The badge is an inline check on the size the shopper picked, so it speaks to that
    // pick first. With too little data it gives a best guess and no fit number.
    let state, verdict;
    const pickedWorse = selected && selected.index !== shown.index && selected.score < shown.score - 10;
    if (confidence < CONFIG.lowConfidence) {
      state = 'lowConfidence'; verdict = `Best guess \u00b7 ${shown.label}`;
    } else if (shown.score < CONFIG.riskFit) {
      state = 'likelyReturn'; verdict = 'Likely return';
    } else if (pickedWorse) {
      state = 'sizeChange'; verdict = `Size ${shown.index > selected.index ? 'up' : 'down'} \u2192 ${shown.label}`;
    } else if (shown.score >= CONFIG.goodFit) {
      state = 'goodBuy'; verdict = `Good buy \u00b7 ${shown.label}`;
    } else {
      state = 'fitRisk'; verdict = `Fit risk \u00b7 ${shown.label}`;
    }
    const showFit = state !== 'lowConfidence';

    const reason = buildReason({ state, shown, selected, best, runnerUp, between, baseline, baseLabel, offset, product, stretch, tiebreakLarger, chart, rungs, target });

    // ---- One alert, in priority order: fit warning, then duplicate.
    let alert = null;
    const soldOutSaid = (state === 'fitRisk' || state === 'likelyReturn');
    if (!best.available && best.index !== shown.index && !soldOutSaid) alert = { kind: 'fit', text: `${best.label} would fit better but is sold out — ${shown.label} is the best size in stock.` };
    else if (baseline.inconsistent) alert = { kind: 'fit', text: `${product.identity.brand} has fit you inconsistently — your past orders disagree, so treat this as a guess.` };
    else if (baseline.conflict) alert = { kind: 'fit', text: `Your wardrobe says ${baseLabel}, not the ${baseline.conflict.stated} you told us — using the wardrobe.` };
    if (!alert) alert = duplicateAlert(profile, product);

    let helpMost = null;
    if (baseline.borrowedFrom) helpMost = `Tell us your usual ${product.identity.category} size`;
    else if (baseline.inconsistent) helpMost = `Rate your recent ${product.identity.brand} orders`;
    else if (offset.reviewStrength < 0.3) helpMost = 'No fit reviews found — a past order from this brand would help most';
    else if (baseline.source === 'stated') helpMost = `Rate a past ${product.identity.brand || 'order'} purchase`;

    return {
      state, verdict, size: shown.label,
      // fit is how well the size matches; hidden (null) when there is too little data to mean anything.
      fit: showFit ? shown.score : null, fitLabel: showFit ? fitLabel(shown.score) : null, fitRaw: shown.score,
      confidence, confidenceLabel, basis, caveats, personalized: true,
      reason, alert, ask, helpMost, evidence,
      scores: scores.map(({ label, score, available, selected: sel }) => ({ label, score: showFit ? score : null, available, selected: sel, best: label === shown.label })),
      selected: selected ? selected.label : null,
      selectedFit: selected && showFit ? selected.score : null,
      why, product: summary(product),
    };
  }

  function labelForRank(rank, system, rungs) {
    let best = null;
    for (const r of rungs) if (!best || Math.abs(r.rank - rank) < Math.abs(best.rank - rank)) best = r;
    if (best && Math.abs(best.rank - rank) < 0.01) return best.options[0].label;
    if (system === 'alpha') {
      const entry = Object.entries(sizes.ALPHA_RANK).find(([, v]) => v === Math.round(rank));
      if (entry) return entry[0];
    }
    return String(Math.round(rank));
  }

  function baselinePhrase(b, baseLabel, product) {
    if (b.source === 'feedback') return `your ${product.identity.brand} ${b.anchor.size} that ${b.anchor.feedback === 'perfect' ? 'fit well' : `ran ${b.anchor.feedback}`}`;
    if (b.source === 'wardrobe-brand') return `your ${product.identity.brand} ${b.anchor.size}`;
    if (b.source === 'wardrobe') return `the ${baseLabel} you usually keep`;
    const cat = b.borrowedFrom ? ` ${b.borrowedFrom}` : '';
    return `your usual${cat} ${baseLabel}`;
  }

  function offsetPhrase(offset) {
    const dist = offset.signals.find((s) => s.key === 'distribution');
    const n = (offset.signals.find((s) => s.rank <= 5) || {}).n;
    if (offset.label === 'true to size') return n ? `reviews say true to size (${n})` : null;
    if (dist && n) {
      const pct = round(((offset.label === 'runs small' ? dist.pctSmall : dist.pctLarge) || 0) * 100);
      return `${offset.label} (${pct}% of ${n} reviewers)`;
    }
    const top = offset.signals.slice().sort((a, b) => b.weight - a.weight)[0];
    return top ? `${offset.label} (${top.detail})` : null;
  }

  function buildReason(c) {
    const text = buildReasonCore(c);
    const b = c.baseline.borrowedFrom;
    return b && !/Borrowed from/.test(text) ? `${text} Borrowed from your ${b} size.` : text;
  }

  function buildReasonCore(c) {
    const { state, shown, selected, best, runnerUp, between, baseline, baseLabel, offset, product, stretch, tiebreakLarger, chart } = c;
    const soldOutBest = best && !best.available && best.index !== shown.index;
    const base = baselinePhrase(baseline, baseLabel, product);
    const off = offsetPhrase(offset);
    const borrowed = baseline.borrowedFrom ? ` Borrowed from your ${baseline.borrowedFrom} size.` : '';
    switch (state) {
      case 'goodBuy':
        if (shown.label === baseLabel) return `${shown.label} matches ${base}${off ? `; ${off}` : ''}.${borrowed}`;
        return `${off ? `${off.replace(/^./, (x) => x.toUpperCase())}, so ` : ''}${shown.label} — based on ${base}.${borrowed}`;
      case 'sizeChange': {
        const why = offset.label !== 'true to size' ? `this ${offset.label} for you` : `${base} points to ${shown.label}`;
        const risk = shown.score < CONFIG.goodFit ? ` ${shown.label} is still not a perfect match.` : '';
        return `You picked ${selected.label}, but ${why}. ${shown.label} is the better size.${risk}`;
      }
      case 'fitRisk': {
        if (soldOutBest) return `${best.label} would fit you best, but it’s sold out. ${shown.label} is the closest size in stock${off ? `, and this ${offset.label}` : ''}.`;
        if (between && runnerUp) {
          const tb = stretch && !tiebreakLarger ? 'the fabric stretches, so the smaller size' : 'no stretch, so the larger size';
          return `Between sizes for you: ${shown.label} ${shown.score}, ${runnerUp.label} ${runnerUp.score}. Tiebreak: ${tb}.`;
        }
        if (chart && chart.marginal) {
          const m = chart.marginal;
          return `${shown.label} is the closest, but ${m.key} is ${Math.abs(m.diff).toFixed(1)}${chart.unit} ${m.diff < 0 ? 'smaller' : 'larger'} than your reference item.`;
        }
        return `${shown.label} is the closest to ${base}, but not a clean match${off ? ` — ${off}` : ''}.`;
      }
      case 'likelyReturn': {
        if (soldOutBest) return `${best.label} would fit you, but it’s sold out, and ${shown.label} is a size off for you (based on ${base}).`;
        const dir = c.target > c.rungs.length - 1 ? 'small' : c.target < 0 ? 'large' : null;
        if (dir) return `Even ${shown.label}, the ${dir === 'small' ? 'largest' : 'smallest'} size available, runs ${dir} for you (based on ${base}).`;
        return `No available size is a good match for ${base}${off ? ` — ${off}` : ''}.`;
      }
      case 'lowConfidence':
        return `Based on ${base}. We couldn\u2019t find reviews or measurements for this item, so we can\u2019t tell yet whether it runs small or large.${borrowed}`;
      default:
        return '';
    }
  }

  function duplicateAlert(profile, product) {
    const items = (profile.wardrobe || []).filter((it) =>
      it.category && it.category === product.identity.category &&
      (product.identity.subcategory ? it.subcategory === product.identity.subcategory : sameBrand(it.brand, product.identity.brand)) &&
      it.url !== product.url);
    if (!items.length) return null;
    const what = product.identity.subcategory || product.identity.category;
    return { kind: 'duplicate', text: `You own ${items.length} like this (${what}).`, items: items.map((i) => i.id) };
  }

  return { score, failed, computeOffset, resolveBaseline, fitFromDistance, fitLabel, brandKey, sameBrand, CONFIG };
});
