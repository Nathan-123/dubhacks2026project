/*
 * badge — (Recommendation) -> rendered UI.
 *
 * Layer 0 (badge chip), layer 1 (card popover) and layer 2 ("how we got this").
 * Everything lives inside a shadow root so a store's global CSS cannot reach it.
 * Knows nothing about stores or scoring: it renders whatever Recommendation it is given.
 */
(function (root) {
  'use strict';

  const PRODUCT_NAME = 'Fitting Room';

  // 20x20 line icons, drawn at 1.8px.
  const ICONS = {
    check: '<path d="M5 10.5l3.2 3.2L15 7" />',
    caution: '<path d="M10 6.5v4.2M10 13.6v.1" /><path d="M8.6 3.4L2.7 14a1.6 1.6 0 001.4 2.4h11.8a1.6 1.6 0 001.4-2.4L11.4 3.4a1.6 1.6 0 00-2.8 0z" />',
    up: '<path d="M10 15.5v-11M5.5 9L10 4.5 14.5 9" />',
    down: '<path d="M10 4.5v11M5.5 11l4.5 4.5 4.5-4.5" />',
    stop: '<circle cx="10" cy="10" r="7" /><path d="M7.5 7.5l5 5M12.5 7.5l-5 5" />',
    question: '<circle cx="10" cy="10" r="7" /><path d="M8.1 8a2 2 0 013.8.8c0 1.4-1.9 1.7-1.9 2.9M10 14v.1" />',
    off: '<circle cx="10" cy="10" r="7" /><path d="M5.2 14.8l9.6-9.6" />',
    close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />',
    chevron: '<path d="M7.5 5l5 5-5 5" />',
    bulb: '<path d="M7.5 15.5h5M8.3 17.5h3.4M10 2.8a5 5 0 00-3 9c.6.5 1 1.2 1 2v.2h4v-.2c0-.8.4-1.5 1-2a5 5 0 00-3-9z" />',
    sparkle: '<path d="M10 3l1.5 4.5L16 9l-4.5 1.5L10 15l-1.5-4.5L4 9l4.5-1.5z" />',
    hanger: '<path d="M10 6.2a1.7 1.7 0 10-1.7-1.7M10 6.2v1.3L3.4 12.3a1 1 0 00.6 1.8h12a1 1 0 00.6-1.8L10 7.5" />',
  };

  // state -> tone + icon. Color never carries meaning alone: every state has words and an icon.
  const STATES = {
    pending: { tone: 'neutral', icon: null },
    runsSmall: { tone: 'caution', icon: 'up' },
    runsLarge: { tone: 'caution', icon: 'down' },
    trueToSize: { tone: 'good', icon: 'check' },
    goodBuy: { tone: 'good', icon: 'check' },
    sizeChange: { tone: 'action', icon: 'up' },
    fitRisk: { tone: 'caution', icon: 'caution' },
    likelyReturn: { tone: 'bad', icon: 'stop' },
    lowConfidence: { tone: 'neutral', icon: 'question' },
    failed: { tone: 'muted', icon: 'off' },
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  /* Same palette as ../ui/tokens.css (light only): white and ink, the photos' red as the one accent. */
  .root {
    --surface: #ffffff; --raised: #ffffff; --subtle: #f2f1ef; --line: #e6e3df; --line-2: #cfcac5;
    --ink: #16181d; --ink-2: #4a4f57; --ink-3: #6b7078; --on-ink: #f7f8f5; --focus: #16181d;
    --accent: #722e1d; --accent-soft: #f5e9e5;
    --good: #0f7a3f; --good-soft: #e9f7ef; --caution: #a15c00; --caution-soft: #fff4df;
    --action: #722e1d; --action-soft: #f5e9e5; --bad: #b42318; --bad-soft: #fdeeec;
    --neutral: #4a4f57; --neutral-soft: #f2f1ef; --muted: #6b7078; --muted-soft: #f2f1ef;
    --shadow-1: 0 1px 2px rgba(70, 30, 20, .06), 0 1px 3px rgba(70, 30, 20, .08);
    --shadow-2: 0 1px 2px rgba(70, 30, 20, .06), 0 24px 56px -24px rgba(90, 34, 20, .35);
    --ease-soft: cubic-bezier(.22, 1, .36, 1);
    font: 400 13px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", sans-serif;
    color: var(--ink); -webkit-font-smoothing: antialiased; color-scheme: light;
  }
  .tone-good { --tone: var(--good); --tone-soft: var(--good-soft); }
  .tone-caution { --tone: var(--caution); --tone-soft: var(--caution-soft); }
  .tone-action { --tone: var(--action); --tone-soft: var(--action-soft); }
  .tone-bad { --tone: var(--bad); --tone-soft: var(--bad-soft); }
  .tone-neutral { --tone: var(--neutral); --tone-soft: var(--neutral-soft); }
  .tone-muted { --tone: var(--muted); --tone-soft: var(--muted-soft); }

  svg.i { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  button { font: inherit; color: inherit; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  /* ---------- layer 0: badge chip ---------- */
  .wrap.floating { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; }
  .wrap.docked { display: block; margin: 10px 0 2px; }
  .chip {
    display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px 0 4px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 999px; box-shadow: var(--shadow-1);
    cursor: pointer; font-size: 13px; font-weight: 650; color: var(--ink); white-space: nowrap;
    transition: box-shadow .3s var(--ease-soft), border-color .3s var(--ease-soft), transform .2s var(--ease-soft);
  }
  .chip:hover { border-color: var(--line-2); box-shadow: var(--shadow-2); }
  .chip:active { transform: scale(.98); }
  .floating .chip { height: 40px; padding-right: 12px; box-shadow: var(--shadow-2); }
  .chip.stale { border-style: dashed; }
  .tile { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 999px; background: var(--tone-soft); color: var(--tone); }
  .tile svg.i { width: 15px; height: 15px; stroke-width: 2.1; }
  .chip .verdict { letter-spacing: -0.01em; }
  .chip .cta { color: var(--accent); font-weight: 700; }
  .bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; margin-left: 2px; }
  .bars i { width: 3px; border-radius: 1px; background: var(--line-2); }
  .bars i:nth-child(1) { height: 5px; } .bars i:nth-child(2) { height: 8px; } .bars i:nth-child(3) { height: 12px; }
  .bars i.on { background: var(--tone); }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-2); border-top-color: var(--accent); animation: spin .8s linear infinite; }
  .pending .verdict { color: var(--ink-2); font-weight: 500; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---------- layer 1: card ---------- */
  .card {
    position: fixed; z-index: 2147483647; width: 348px; max-width: calc(100vw - 24px);
    max-height: min(620px, calc(100vh - 24px)); overflow: auto; overscroll-behavior: contain;
    background: var(--raised); color: var(--ink); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow-2);
    animation: rise .4s var(--ease-soft);
  }
  .card[hidden] { display: none; }
  .card:focus { outline: none; }
  @keyframes rise { from { opacity: 0; transform: translateY(4px) scale(.985); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .card, .spinner { animation: none; } .chip { transition: none; } }

  .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 0 16px; }
  .brand { font-weight: 800; font-size: 14px; letter-spacing: -0.02em; }
  .iconbtn { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); cursor: pointer; }
  .iconbtn:hover { background: var(--subtle); color: var(--ink); }

  .body { padding: 12px 16px 14px; }
  .hero { display: flex; gap: 14px; align-items: center; padding: 14px; border-radius: 14px; background: var(--tone-soft); }
  .size { display: grid; place-items: center; min-width: 58px; height: 58px; padding: 0 12px; border-radius: 999px; background: var(--ink); color: var(--on-ink); font-size: 22px; font-weight: 800; letter-spacing: -0.02em; box-shadow: var(--shadow-1); }
  .size.guess { border: 1.5px dashed var(--line-2); box-shadow: none; background: transparent; color: var(--ink-2); }
  .size.icon { color: var(--tone); } .size.icon svg.i { width: 26px; height: 26px; stroke-width: 2; }
  .hero .title { font-size: 17px; font-weight: 800; letter-spacing: -0.02em; color: var(--ink); line-height: 1.25; }
  .hero .sub { margin-top: 2px; font-size: 12.5px; color: var(--ink-2); }
  .reason { margin: 12px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); }

  .section { margin-top: 14px; }
  .label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; font-size: 11.5px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--ink-3); }
  .label span:last-child { text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--ink-2); font-size: 12px; }

  .ladder { display: flex; gap: 6px; }
  .rung { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .cell { position: relative; width: 100%; height: 34px; display: grid; place-items: center; border-radius: 9px; background: var(--subtle); color: var(--ink-2); font-weight: 650; font-size: 13px; border: 1.5px solid transparent; overflow: hidden; }
  .cell .fill { position: absolute; left: 0; right: 0; bottom: 0; background: var(--tone-soft); }
  .cell .t { position: relative; }
  .rung.best .cell { background: var(--tone); color: #fff; }
  .rung.best .cell .fill { display: none; }
  .rung.sel .cell { border-color: var(--ink); }
  .rung.oos .cell { color: var(--ink-3); background: repeating-linear-gradient(135deg, var(--subtle) 0 5px, transparent 5px 9px); text-decoration: line-through; }
  .rung .n { font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; height: 14px; white-space: nowrap; }
  .rung.best .n { color: var(--tone); font-weight: 650; }
  .ladder-legend { display: flex; gap: 12px; margin-top: 8px; font-size: 11.5px; color: var(--ink-3); flex-wrap: wrap; }
  .ladder-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; vertical-align: -1px; margin-right: 4px; }

  .dist { display: flex; height: 8px; border-radius: 99px; overflow: hidden; background: var(--subtle); gap: 2px; }
  .dist i { display: block; height: 100%; }
  .dist .s { background: var(--caution); } .dist .t { background: var(--good); } .dist .l { background: var(--action); }
  .dist-legend { display: flex; justify-content: space-between; margin-top: 7px; font-size: 12px; color: var(--ink-2); }
  .dist-legend b { font-variant-numeric: tabular-nums; color: var(--ink); }

  .meter { display: flex; gap: 3px; }
  .meter i { flex: 1; height: 6px; border-radius: 99px; background: var(--subtle); }
  .meter i.on { background: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 9px; }
  .based { font-size: 12px; color: var(--ink-3); margin-right: 2px; }
  .chipline { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 99px; background: var(--subtle); color: var(--ink-2); font-size: 12px; font-weight: 500; }
  .chipline.ai { background: var(--accent-soft); color: var(--accent); }
  .chipline.ai svg.i { width: 12px; height: 12px; }
  .caveat { margin-top: 7px; font-size: 12px; color: var(--ink-3); }

  .callout { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; padding: 10px 12px; border-radius: 12px; font-size: 12.5px; line-height: 1.45; }
  .callout svg.i { margin-top: 1px; }
  .callout.fit { background: var(--caution-soft); color: var(--caution); }
  .callout.fit span { color: var(--ink); }
  .callout.duplicate { background: var(--subtle); color: var(--ink-2); }
  .callout.tip { background: transparent; border: 1px dashed var(--line-2); color: var(--ink-3); }
  .callout.tip span { color: var(--ink-2); }

  .ask { margin-top: 14px; padding: 14px; border-radius: 14px; border: 1px solid var(--line); background: #fbfbfa; }
  .ask .q { font-weight: 650; font-size: 13.5px; }
  .ask .hint { margin-top: 2px; font-size: 12px; color: var(--ink-3); }
  .opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .opt { min-width: 42px; height: 34px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-weight: 650; cursor: pointer; transition: border-color .3s var(--ease-soft), box-shadow .3s var(--ease-soft); }
  .opt:hover { border-color: var(--line-2); box-shadow: 0 6px 16px -8px rgba(70, 30, 20, .3); }
  .textbtn { border: 0; background: none; padding: 6px 0 0; color: var(--ink-3); font-size: 12px; cursor: pointer; min-height: 24px; }
  .textbtn:hover { color: var(--ink); }

  .foot { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px 8px 16px; border-top: 1px solid var(--line); }
  .linkbtn { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; padding: 4px 6px; margin: 0 -6px; border-radius: 6px; color: var(--ink-2); font-size: 12.5px; font-weight: 550; cursor: pointer; min-height: 28px; }
  .linkbtn:hover { color: var(--ink); background: var(--subtle); }
  .linkbtn svg.i { width: 14px; height: 14px; transition: transform .15s; }
  .linkbtn[aria-expanded="true"] svg.i { transform: rotate(90deg); }
  .linkbtn.primary { color: var(--accent); }

  /* ---------- layer 2: how we got this ---------- */
  .why { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; font-size: 12.5px; color: var(--ink-2); }
  .why h4 { margin: 14px 0 6px; font-size: 11.5px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--ink-3); }
  .why h4:first-child { margin-top: 0; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .row .k { color: var(--ink-2); } .row .v { color: var(--ink); font-weight: 550; text-align: right; font-variant-numeric: tabular-nums; }
  .row .v.pos { color: var(--good); } .row .v.neg { color: var(--bad); }
  .formula { padding: 10px 12px; border-radius: 10px; background: var(--subtle); color: var(--ink); font-size: 12.5px; line-height: 1.6; }
  .src { font: 11.5px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; color: var(--ink-3); }
  `;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function icon(name) {
    return `<svg class="i" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  }
  const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

  function stateOf(rec) {
    const st = STATES[rec.state] || STATES.lowConfidence;
    if (rec.state === 'sizeChange' && /down/i.test(rec.verdict || '')) return { ...st, icon: 'down' };
    return st;
  }

  function confLevel(rec) {
    if (!rec.personalized) return 0;
    return rec.confidenceLabel === 'High' ? 3 : rec.confidenceLabel === 'Medium' ? 2 : 1;
  }

  function heroTitle(rec) {
    switch (rec.state) {
      case 'goodBuy': return 'Good buy';
      case 'fitRisk': return 'Fit risk';
      case 'sizeChange': return /down/i.test(rec.verdict) ? 'Size down' : 'Size up';
      case 'lowConfidence': return rec.size ? 'Best guess' : 'No fit data yet';
      default: return rec.verdict;
    }
  }

  function heroSub(rec) {
    switch (rec.state) {
      case 'runsSmall': case 'runsLarge': case 'trueToSize':
        return 'From reviews. Not personalized yet';
      case 'lowConfidence': return rec.size ? 'Your usual size. No fit data on this item yet' : 'Tell us your size for a recommendation';
      case 'failed': return 'We couldn’t find the sizes on this page';
      case 'sizeChange': return rec.selected ? `Better than the ${rec.selected} you picked` : (rec.fitLabel || '');
      case 'likelyReturn': return rec.size ? `Even ${rec.size}, the closest available, is a ${String(rec.fitLabel || 'poor fit').toLowerCase()}` : '';
      default: return rec.fit != null ? `${rec.fitLabel} · ${rec.fit}/100 for you` : '';
    }
  }

  /**
   * create(handlers) -> { mount(anchor|null), render(rec, meta), destroy(), open(), close() }
   * handlers: onAsk(label), onDismissAsk(), onOpenWardrobe(rec), onRetry()
   */
  function create(handlers) {
    handlers = handlers || {};
    const host = document.createElement('fitting-room-badge');
    host.setAttribute('data-fitting-room', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><div class="root"><div class="wrap floating"><button class="chip tone-neutral" type="button" aria-haspopup="dialog" aria-expanded="false"></button></div><div class="card" role="dialog" aria-modal="false" hidden tabindex="-1"></div></div>`;
    const wrap = shadow.querySelector('.wrap');
    const btn = shadow.querySelector('.chip');
    const card = shadow.querySelector('.card');
    let rec = null;
    let meta = {};
    let whyOpen = false;
    let isOpen = false;

    function position() {
      if (!isOpen) return;
      const r = btn.getBoundingClientRect();
      const w = Math.min(348, window.innerWidth - 24);
      const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
      card.style.left = `${left}px`;
      const below = window.innerHeight - r.bottom;
      const h = card.offsetHeight || 400;
      if (below >= h + 16 || below >= r.top) { card.style.top = `${r.bottom + 8}px`; card.style.bottom = 'auto'; }
      else { card.style.top = 'auto'; card.style.bottom = `${window.innerHeight - r.top + 8}px`; }
    }

    function open() {
      if (!rec || rec.state === 'pending') return;
      isOpen = true;
      card.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      renderCard();
      position();
      card.focus({ preventScroll: true });
    }
    function close(returnFocus) {
      if (!isOpen) return;
      isOpen = false;
      card.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (returnFocus !== false) btn.focus({ preventScroll: true });
    }

    btn.addEventListener('click', (e) => { e.stopPropagation(); isOpen ? close() : open(); });
    shadow.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    const outside = (e) => { if (isOpen && !e.composedPath().includes(host)) close(false); };
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('scroll', position, { passive: true });
    window.addEventListener('resize', position);

    card.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.getAttribute('data-act');
      if (act === 'close') close();
      else if (act === 'why') { whyOpen = !whyOpen; renderCard(); }
      else if (act === 'ask' && handlers.onAsk) handlers.onAsk(t.getAttribute('data-label'));
      else if (act === 'dismiss-ask' && handlers.onDismissAsk) handlers.onDismissAsk();
      else if (act === 'wardrobe' && handlers.onOpenWardrobe) handlers.onOpenWardrobe(rec);
      else if (act === 'retry' && handlers.onRetry) handlers.onRetry();
    });

    // ---- layer 0
    function renderChip() {
      const st = stateOf(rec);
      const pending = rec.state === 'pending';
      btn.className = `chip tone-${st.tone}${meta.stale ? ' stale' : ''}${pending ? ' pending' : ''}`;
      const lvl = confLevel(rec);
      const bars = lvl ? `<span class="bars" aria-hidden="true">${[1, 2, 3].map((n) => `<i class="${n <= lvl ? 'on' : ''}"></i>`).join('')}</span>` : '';
      const lead = pending ? '<span class="tile"><span class="spinner"></span></span>' : `<span class="tile">${icon(st.icon)}</span>`;
      // Without a size the verdict is only the crowd's, so invite the one tap that personalizes it.
      const wantsSize = !pending && !rec.personalized && rec.ask && rec.ask.type === 'usualSize';
      const cta = wantsSize ? '<span class="cta">Your size?</span>' : '';
      btn.innerHTML = `${lead}<span class="verdict">${esc(pending ? 'Checking fit…' : rec.verdict)}</span>${bars}${cta}`;
      const label = `${PRODUCT_NAME}: ${pending ? 'checking fit' : rec.verdict}${rec.personalized ? `, ${rec.confidenceLabel} confidence` : ''}${meta.stale ? ', saved result' : ''}. ${wantsSize ? 'Add your size' : 'Show details'}.`;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-busy', pending ? 'true' : 'false');
    }

    // ---- layer 1 pieces
    function hero() {
      const st = stateOf(rec);
      const tile = rec.size && rec.state !== 'failed'
        ? `<div class="size${rec.state === 'lowConfidence' ? ' guess' : ''}">${esc(rec.size)}</div>`
        : `<div class="size icon">${icon(st.icon)}</div>`;
      return `<div class="hero tone-${st.tone}">${tile}<div><div class="title" id="fc-title">${esc(heroTitle(rec))}</div><div class="sub">${esc(heroSub(rec))}</div></div></div>`;
    }

    function ladder() {
      const rows = rec.scores || [];
      if (!rec.personalized || !rows.length || rows.every((s) => s.score == null)) return '';
      const seen = new Set();
      const rungs = rows.filter((s) => (seen.has(s.label) ? false : seen.add(s.label)));
      const picked = rows.some((s) => s.selected);
      return `<div class="section"><div class="label"><span>Fit by size</span><span>${esc(rec.fitLabel || '')}</span></div>
        <div class="ladder" role="list">${rungs.map((s) => `
          <div class="rung${s.best ? ' best' : ''}${s.selected ? ' sel' : ''}${s.available ? '' : ' oos'}" role="listitem" aria-label="${esc(s.label)}: fit ${s.score} of 100${s.available ? '' : ', sold out'}${s.selected ? ', your pick' : ''}${s.best ? ', recommended' : ''}">
            <div class="cell"><span class="fill" style="height:${Math.round((s.score || 0) * 0.34)}px"></span><span class="t">${esc(s.label)}</span></div>
            <div class="n">${s.available ? s.score : 'Sold out'}</div>
          </div>`).join('')}</div>
        <div class="ladder-legend"><span><i style="background:var(--tone)"></i>Recommended</span>${picked ? '<span><i style="border:1.5px solid var(--ink)"></i>Your pick</span>' : ''}<span>Fit score out of 100</span></div></div>`;
    }

    function distribution() {
      const d = rec.distribution;
      if (!d || rec.personalized) return '';
      const pct = (x) => Math.round((x || 0) * 100);
      return `<div class="section"><div class="label"><span>What reviewers say</span><span>${d.n ? `${d.n} reviews` : ''}</span></div>
        <div class="dist" role="img" aria-label="${pct(d.small)}% runs small, ${pct(d.true)}% true to size, ${pct(d.large)}% runs large"><i class="s" style="width:${pct(d.small)}%"></i><i class="t" style="width:${pct(d.true)}%"></i><i class="l" style="width:${pct(d.large)}%"></i></div>
        <div class="dist-legend"><span>Runs small <b>${pct(d.small)}%</b></span><span>True to size <b>${pct(d.true)}%</b></span><span>Runs large <b>${pct(d.large)}%</b></span></div></div>`;
    }

    function confidence() {
      if (!rec.personalized) return '';
      const segs = Math.max(1, Math.round((rec.confidence || 0) / 20));
      const src = rec.why && rec.why.confidenceSource;
      const ai = src && src.kind === 'model' ? `<span class="chipline ai" title="Confidence assessed by ${esc(src.model || 'a model')}">${icon('sparkle')}AI-assessed</span>` : '';
      const basis = (rec.basis || []).map((b) => `<span class="chipline">${esc(b)}</span>`).join('');
      const note = src && src.kind === 'model' && src.note ? src.note : (rec.caveats && rec.caveats[0] ? cap(rec.caveats[0]) : '');
      return `<div class="section"><div class="label"><span>Confidence</span><span>${esc(rec.confidenceLabel)}</span></div>
        <div class="meter" role="img" aria-label="Confidence ${esc(rec.confidenceLabel)}, ${rec.confidence} of 100">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= segs ? 'on' : ''}"></i>`).join('')}</div>
        <div class="chips"><span class="based">Based on</span>${basis}${ai}</div>
        ${note ? `<div class="caveat">${esc(note)}</div>` : ''}</div>`;
    }

    function callout() {
      if (!rec.alert) return '';
      return `<div class="callout ${esc(rec.alert.kind)}" role="note">${icon(rec.alert.kind === 'fit' ? 'caution' : 'hanger')}<span>${esc(rec.alert.text)}</span></div>`;
    }

    function ask() {
      if (!rec.ask) return '';
      const hint = rec.ask.type === 'fitPreference' ? 'Slim sizes down a little, relaxed sizes up. Used on every store.' : 'One tap. We’ll personalize every store from here.';
      return `<div class="ask"><div class="q" id="fc-ask">${esc(rec.ask.question)}</div><div class="hint">${esc(hint)}</div>
        <div class="opts" role="group" aria-labelledby="fc-ask">${rec.ask.options.map((l) => `<button class="opt" type="button" data-act="ask" data-label="${esc(l)}">${esc(l)}</button>`).join('')}</div>
        <button class="textbtn" type="button" data-act="dismiss-ask">Not now</button></div>`;
    }

    function tip() {
      if (!rec.helpMost || rec.ask || rec.state === 'failed') return '';
      return `<div class="callout tip">${icon('bulb')}<span>${esc(rec.helpMost)}</span></div>`;
    }

    function failed() {
      if (rec.state !== 'failed') return '';
      return `<div class="callout tip">${icon('bulb')}<span>Use the store’s own size chart for this one. <button class="linkbtn primary" type="button" data-act="retry" style="margin:0;padding:0 2px;min-height:0">Try again</button></span></div>`;
    }

    // ---- layer 2
    function whyPanel() {
      const w = rec.why || {};
      const o = w.offset || {};
      const b = w.baseline;
      const sign = (x) => `${x > 0 ? '+' : ''}${x}`;
      const sources = { feedback: 'your fit feedback on this brand', 'wardrobe-brand': 'your orders from this brand', wardrobe: 'the sizes you keep', stated: 'the size you told us' };
      const signals = (o.signals || []).map((s) => `<div class="row"><span class="k">${esc(cap(s.detail))}</span><span class="v">${s.steps < -0.05 ? 'Runs small' : s.steps > 0.05 ? 'Runs large' : 'True to size'}</span></div>`).join('')
        || '<div class="row"><span class="k">No reviews, chart or fit notes found</span><span class="v">None</span></div>';
      const parts = (w.confidenceParts || []).map((p) => `<div class="row"><span class="k">${esc(cap(p.why))}</span><span class="v ${p.pts > 0 ? 'pos' : 'neg'}">${sign(p.pts)}</span></div>`).join('');
      const cs = w.confidenceSource;
      const model = cs && cs.kind === 'model' ? `<div class="row"><span class="k">AI assessment · ${esc(cs.model || 'model')}</span><span class="v">${rec.confidence}</span></div><div class="row"><span class="k">Rule-based estimate</span><span class="v">${cs.rules}</span></div>` : '';
      const extra = [
        w.fabric ? `<div class="row"><span class="k">Fabric</span><span class="v">${esc(w.fabric.composition.map((c) => `${c.pct}% ${c.material}`).join(', '))}${w.fabric.stretch ? ' · stretch' : ''}</span></div>` : '',
        w.modelRef ? `<div class="row"><span class="k">Model wears</span><span class="v">${esc(w.modelRef.sizeWorn)} at ${w.modelRef.heightCm} cm</span></div>` : '',
        w.chart ? `<div class="row"><span class="k">Closest to your reference item</span><span class="v">${esc(w.chart.size)}</span></div>` : '',
      ].join('');
      const steps = Math.abs(o.steps || 0);
      const move = steps >= 0.25 ? `, about ${steps >= 0.75 ? 'one size' : 'half a size'} ${o.steps < 0 ? 'small' : 'large'}` : '';
      const src = Object.entries(w.src || {}).map(([k, v]) => `<div class="row"><span class="k src">${esc(k)}</span><span class="v src">${esc(v)}</span></div>`).join('');
      return `<div class="why" id="fc-why">
        <h4>How the size was picked</h4>
        <div class="formula">${b ? `Start from <b>${esc(b.label)}</b>, ${esc(sources[b.source] || b.source)}${b.borrowedFrom ? ` (borrowed from your ${esc(b.borrowedFrom)} size)` : ''}.<br>` : 'No size from you yet, so this is the crowd signal only.<br>'}This item ${esc(o.label || 'has no fit signal')}${esc(move)}.${b && rec.size ? ` Result: <b>${esc(rec.size)}</b>.` : ''}</div>
        <h4>Item signals</h4>${signals}${extra}
        ${parts ? `<h4>Confidence · ${rec.confidence}/100</h4>${model}${parts}` : ''}
        <h4>Where the data came from</h4>${src || '<div class="row"><span class="k">Nothing recorded</span></div>'}
        ${meta.stale ? '<p class="caveat">Showing a saved reading of this page.</p>' : ''}
      </div>`;
    }

    function renderCard() {
      if (!isOpen || !rec) return;
      const st = stateOf(rec);
      card.innerHTML = `
        <div class="head"><span class="brand">${PRODUCT_NAME}</span><button class="iconbtn" type="button" data-act="close" aria-label="Close">${icon('close')}</button></div>
        <div class="body tone-${st.tone}">
          ${hero()}
          ${rec.reason ? `<p class="reason">${esc(rec.reason)}</p>` : ''}
          ${distribution()}
          ${ladder()}
          ${confidence()}
          ${callout()}
          ${tip()}
          ${failed()}
          ${ask()}
          ${whyOpen ? whyPanel() : ''}
        </div>
        <div class="foot">
          <button class="linkbtn" type="button" data-act="why" aria-expanded="${whyOpen}" aria-controls="fc-why">${icon('chevron')}How we got this</button>
          <button class="linkbtn primary" type="button" data-act="wardrobe">Your closet</button>
        </div>`;
      card.setAttribute('aria-labelledby', 'fc-title');
    }

    return {
      host,
      mount(anchor) {
        if (anchor && anchor.parentNode) {
          wrap.className = 'wrap docked';
          meta.floating = false;
          if (host.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', host);
        } else {
          wrap.className = 'wrap floating';
          meta.floating = true;
          if (!host.isConnected) document.documentElement.appendChild(host);
        }
      },
      render(next, m) {
        rec = next;
        meta = { ...meta, ...(m || {}) };
        renderChip();
        if (rec.state === 'pending') close(false);
        else renderCard();
      },
      open, close,
      destroy() {
        document.removeEventListener('mousedown', outside, true);
        window.removeEventListener('scroll', position);
        window.removeEventListener('resize', position);
        host.remove();
      },
    };
  }

  (root.FitKit = root.FitKit || {}).badge = { create, STATES, PRODUCT_NAME, heroTitle, heroSub };
})(typeof globalThis !== 'undefined' ? globalThis : this);
