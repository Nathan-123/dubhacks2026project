/*
 * Probe reporter. Concatenated after the real extractor by scripts/build-probe.js into
 * probe/fit-probe.js — so the coverage it reports is exactly what the product will get.
 *
 * Read-only: it makes the same sub-request the store's own theme makes (Shopify
 * /products/<handle>.js) and nothing else. Nothing leaves your machine.
 */
(async function fitProbe() {
  const K = globalThis.FitKit;
  const url = location.href;
  const signals = {};

  // Raw signals, independent of whether the extractor used them.
  const ld = K.extract.jsonLdNodes(document);
  signals.jsonLdTypes = [...new Set(ld.flatMap((n) => [].concat(n['@type'] || [])))];
  signals.shopify = K.extract._internal.isShopify(document, url);
  signals.nextData = !!document.querySelector('script#__NEXT_DATA__');
  signals.nuxt = [...document.querySelectorAll('script')].some((s) => /__NUXT__\s*=/.test(s.textContent || ''));
  signals.digitalData = [...document.querySelectorAll('script')].some((s) => /digitalData\s*=/.test(s.textContent || ''));
  signals.jsonScripts = document.querySelectorAll('script[type="application/json"]').length;
  const region = K.extract._internal.reviewRegion(document, {});
  signals.reviewPlatform = region ? region.platform : null;
  const bodyText = (document.body.innerText || '');
  signals.fitTextOnPage = (bodyText.match(/runs?\s*(small|large|big)|true\s*to\s*size/gi) || []).slice(0, 5);
  signals.sizeChartTables = [...document.querySelectorAll('table')].filter((t) => /size/i.test(t.textContent || '')).length;
  signals.sizeChartImage = [...document.querySelectorAll('img')].some((i) => /size[\s_-]?(chart|guide)/i.test(`${i.getAttribute('alt') || ''} ${i.getAttribute('src') || ''}`));
  signals.sizeChartModalTrigger = [...document.querySelectorAll('a, button')].some((b) => /size\s*(chart|guide)|fit\s*guide/i.test(b.textContent || ''));

  const started = performance.now();
  const res = await K.extract.extract(document, {
    url,
    fetchJson: async (u) => { const r = await fetch(u, { credentials: 'same-origin' }); return r.ok ? r.json() : null; },
  });
  const ms = Math.round(performance.now() - started);

  const product = res.product || null;
  const fields = product ? K.contract.TRACKED.map((p) => ({
    field: p,
    filled: K.contract.isFilled(K.contract.get(product, p)),
    tier: product._src[p] || '',
  })) : [];
  const verdict = res.silent ? `SILENT (${res.reason})` : res.ok ? 'FLOOR OK' : `FLOOR MISSING: ${(res.missing || []).join(', ')} -> needs the LLM tier (free local model)`;
  const rung0 = res.ok ? K.score.score(product, {}) : null;

  const report = {
    url,
    host: location.hostname,
    verdict,
    ms,
    tiersFilled: res.tiers || {},
    reviewPlatform: res.reviewPlatform || null,
    rung0Badge: rung0 ? `${rung0.verdict} — ${rung0.reason}` : null,
    signals,
    fields: Object.fromEntries(fields.map((f) => [f.field, f.filled ? f.tier : null])),
    sizes: product && product.sizes.options ? product.sizes.options.map((o) => `${o.label}${o.available ? '' : '(oos)'}${o.selected ? '*' : ''}`).join(' ') : null,
    sizeSystem: product ? product.sizes.system : null,
    dockable: !!(product && product.sizes.docked),
    chartKind: product && product.sizeChart ? (product.sizeChart.imageOnly ? 'image' : product.sizeChart.kind) : null,
    reviewFit: product ? product.reviewFit : null,
  };

  console.log('%cFitCheck probe', 'font-weight:bold;font-size:14px', verdict, `(${ms}ms)`);
  console.table(fields.map((f) => ({ field: f.field, filled: f.filled ? 'yes' : '', tier: f.tier })));
  console.log('Raw signals', signals);
  if (rung0) console.log('Rung-0 badge would say:', rung0.verdict, '—', rung0.reason);
  try { if (typeof copy === 'function') { copy(JSON.stringify(report, null, 2)); console.log('Report JSON copied to clipboard — paste it into probe/results/<store>.json'); } } catch (_) { /* copy() only exists in DevTools */ }
  return report;
})();
