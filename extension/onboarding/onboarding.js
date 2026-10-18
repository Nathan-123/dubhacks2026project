'use strict';

/*
 * onboarding — first-run setup. Four optional answers (section, height, fit, best-fitting
 * piece), one at a time on a centered card framed by garment photos. Saved to the profile on Save.
 */
(function () {
  const K = window.FitKit;
  const P = K.profile;
  const $ = (id) => document.getElementById(id);

  const FITS = ['fitted', 'regular', 'relaxed', 'oversized'];
  const FIT_LABEL = { fitted: 'Slim', regular: 'Regular', relaxed: 'Relaxed', oversized: 'Oversized' };
  // Background prints, each photo once, framing the centered card: an inner column hugging each side of the card
  // and one print bleeding off each edge. dx/dy are the top-left offset from the page centre and w the width,
  // all in px on a 1440x900 artboard (CSS scales them); r is tilt.
  const LOOKS = [
    { name: 'tee', kind: 'top', dx: -545, dy: -415, w: 175, r: -4 },
    { name: 'flannel', kind: 'top', dx: 355, dy: -430, w: 190, r: 3 },
    { name: 'jeans', kind: 'bottom', dx: -565, dy: -150, w: 205, r: 2.5 },
    { name: 'sneakers', kind: '', dx: 365, dy: -140, w: 200, r: -3 },
    { name: 'cargo', kind: 'bottom', dx: -760, dy: -175, w: 170, r: -2 },
    { name: 'hoodie', kind: 'top', dx: 590, dy: -60, w: 195, r: 2 },
    { name: 'cap', kind: '', dx: -530, dy: 170, w: 165, r: -5 },
    { name: 'sweats', kind: 'bottom', dx: 360, dy: 160, w: 170, r: 4 },
  ];
  const TOPS = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const WAISTS = ['26', '27', '28', '29', '30', '31', '32', '33', '34', '36', '38', '40'];
  const LENGTHS = ['28', '30', '32', '34', '36'];
  const BRANDS = ['Uniqlo', 'Levi’s', 'Zara', 'H&M', 'Nike', 'Gap', 'Everlane', 'Abercrombie & Fitch'];
  const SECTION_LABEL = { men: 'Men’s', women: 'Women’s', both: 'Both' };

  // Outside the extension (a file preview) there is no chrome.storage; keep answers in memory.
  const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  const state = {
    section: null, unit: 'imperial', heightCm: null, fit: null,
    kind: 'top', brand: '', size: null, length: null,
  };

  // ---------------------------------------------------------------------------
  // answers -> profile

  function anchorItem() {
    if (!state.brand.trim() || !state.size) return null;
    const bottom = state.kind === 'bottom';
    return {
      brand: state.brand.trim(), category: bottom ? 'bottom' : 'top', subcategory: null,
      section: state.section === 'both' ? null : state.section,
      size: bottom && state.length ? `${state.size}x${state.length}` : state.size,
      system: bottom ? (state.length ? 'waistInseam' : 'waist') : 'alpha',
    };
  }

  function events() {
    return [
      { type: 'setSection', section: state.section },
      { type: 'setBody', body: state.heightCm ? { heightCm: state.heightCm } : null },
      { type: 'setPreference', preference: state.fit },
      { type: 'setAnchorItem', item: anchorItem() },
    ];
  }

  const answered = () => ({ section: !!state.section, body: !!state.heightCm, fit: !!state.fit, anchor: !!anchorItem() });

  // ---------------------------------------------------------------------------
  // render: form

  function setChecked(selector, attr, value) {
    document.querySelectorAll(selector).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[attr] === String(value))));
  }

  function heightText(cm) {
    if (!cm) return 'Not set';
    if (state.unit === 'metric') return `${cm} cm`;
    const inches = Math.round(cm / 2.54);
    return `${Math.floor(inches / 12)}′${inches % 12}″`;
  }

  // Height is typed: feet + inches, or centimeters. Returns cm, null when empty, or NaN when out of range.
  const HEIGHT_CM = [120, 230];
  function readHeight() {
    const num = (id) => ($(id).value.trim() === '' ? null : Number($(id).value.replace(',', '.')));
    let cm;
    if (state.unit === 'metric') {
      const v = num('height-cm');
      if (v == null) return null;
      cm = v;
    } else {
      const ft = num('height-ft');
      const inch = num('height-in');
      if (ft == null && inch == null) return null;
      if (inch != null && (inch < 0 || inch >= 12)) return NaN;
      cm = (ft || 0) * 30.48 + (inch || 0) * 2.54;
    }
    return Number.isFinite(cm) && cm >= HEIGHT_CM[0] && cm <= HEIGHT_CM[1] ? Math.round(cm) : NaN;
  }

  function fillHeight() {
    const cm = state.heightCm;
    const inches = cm ? Math.round(cm / 2.54) : null;
    $('height-cm').value = cm || '';
    $('height-ft').value = cm ? Math.floor(inches / 12) : '';
    $('height-in').value = cm ? inches % 12 : '';
  }

  function sizePills(el, labels, current, attr) {
    el.innerHTML = labels.map((l) => `<button type="button" class="choice size" role="radio" aria-checked="${current === l}" data-${attr}="${l}">${l}</button>`).join('');
  }

  function renderForm() {
    setChecked('[data-section]', 'section', state.section);
    setChecked('[data-unit]', 'unit', state.unit);
    setChecked('button[data-kind]', 'kind', state.kind);
    setChecked('[data-fit]', 'fit', state.fit ? FITS.indexOf(state.fit) : '');

    $('height-imperial').hidden = state.unit === 'metric';
    $('height-metric').hidden = state.unit !== 'metric';
    $('fit').classList.toggle('unset', !state.fit);
    $('fit').setAttribute('aria-valuetext', state.fit ? FIT_LABEL[state.fit] : 'Not set');

    $('brand-chips').innerHTML = BRANDS.map((b) => `<button type="button" class="chip" aria-pressed="${state.brand === b}" data-brand="${b}">${K.logos.markup(K.logos.find({}, b), b)}${b}</button>`).join('');
    K.logos.guard($('brand-chips'));
    const bottom = state.kind === 'bottom';
    $('size-label').textContent = bottom ? 'Waist' : 'Size';
    sizePills($('sizes'), bottom ? WAISTS : TOPS, state.size, 'size');
    $('length-wrap').hidden = !bottom;
    if (bottom) sizePills($('lengths'), LENGTHS, state.length, 'length');

    const a = answered();
    for (const [k, v] of Object.entries(a)) document.querySelector(`[data-q="${k}"]`).classList.toggle('answered', v);
    const n = Object.values(a).filter(Boolean).length;
    $('count').textContent = `${n} of 4 answered`;
    $('stitch').style.strokeDashoffset = String(156 - n * 39);
  }

  // ---------------------------------------------------------------------------
  // render: background

  // Background: prints laid on a table around the card.
  function renderMosaic() {
    $('mosaic').innerHTML = LOOKS.map((l, i) =>
      `<div class="piece" data-kind="${l.kind}" style="--dx:${l.dx};--dy:${l.dy};--w:${l.w};--r:${l.r}deg;--i:${i}">` +
      `<div class="float"><img class="print" src="looks/${l.name}.jpg" alt=""></div></div>`).join('');
  }


  function update() {
    const h0 = $('stage').offsetHeight;
    if (resize) resize.cancel();
    renderForm();
    renderNav();
    if (moving || reduceMotion()) return;
    // A change inside a question (the height Clear button, say) eases the card to its new height instead of jumping.
    const h1 = $('stage').offsetHeight;
    if (h1 !== h0) resize = $('stage').animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 560, easing: EASE_SOFT });
  }

  function applyKind(kind) {
    if (state.kind === kind) return;
    state.kind = kind; state.size = null; state.length = null;
  }

  // Top <-> bottom swaps the whole size area, in three beats: the old sizes blur away, the card eases to its
  // new height, then the new rows settle in one after another. The switch thumb and the background prints
  // answer the click at once, so the swap never feels unacknowledged. Toggling mid-swap retargets it.
  let pendingKind = null;
  async function switchKind(kind) {
    setChecked('button[data-kind]', 'kind', kind);
    $('mosaic').dataset.focus = kind;
    if (moving || reduceMotion()) { applyKind(kind); update(); return; }
    const busy = pendingKind !== null;
    pendingKind = kind;
    if (busy) return;

    const area = $('size-area');
    const stage = $('stage');
    const out = area.animate(
      [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-6px)', filter: 'blur(4px)' }],
      { duration: 240, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
    await out.finished;

    const h0 = stage.offsetHeight;
    if (resize) resize.cancel();
    applyKind(pendingKind);
    pendingKind = null;
    renderForm();
    renderNav();
    const h1 = stage.offsetHeight;
    resize = stage.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 720, easing: EASE_SOFT });
    area.querySelectorAll('.field-label, .choice').forEach((el, i) => el.animate(
      [{ opacity: 0, transform: 'translateY(8px)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
      { duration: 560, delay: 160 + i * 18, easing: EASE_SOFT, fill: 'backwards' }));
    out.cancel();
  }

  // ---------------------------------------------------------------------------
  // events

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.section) {
      state.section = state.section === d.section ? null : d.section;
      update();
      // A single tap answers this one, so move on once the pick has registered.
      if (state.section) setTimeout(() => { if (STEPS[step] === 'section') goTo(step + 1); }, 420);
    }
    else if (d.unit) { if (state.unit !== d.unit) { state.unit = d.unit; fillHeight(); showHeightError(false); } update(); }
    else if (d.fit !== undefined && t.closest('.fit-stops')) { state.fit = FITS[Number(d.fit)]; $('fit').value = d.fit; update(); }
    else if (d.kind) switchKind(d.kind);
    else if (d.brand) { state.brand = d.brand; $('brand').value = d.brand; update(); }
    else if (d.size) { state.size = state.size === d.size ? null : d.size; update(); }
    else if (d.length) { state.length = state.length === d.length ? null : d.length; update(); }
  });

  // Errors wait until the field is left, so a half-typed "1" never shouts; fixing it clears the error at once.
  function showHeightError(show) {
    const range = state.unit === 'metric' ? '120 and 230 cm' : '4′0″ and 7′6″ (inches 0 to 11)';
    $('height-error').textContent = show ? `Enter a height between ${range}.` : '';
    $('height-error').hidden = !show;
    document.querySelectorAll('.height-fields input').forEach((i) => i.setAttribute('aria-invalid', String(show)));
  }
  document.querySelectorAll('.height-fields input').forEach((input) => {
    input.addEventListener('input', () => {
      const cm = readHeight();
      state.heightCm = Number.isNaN(cm) ? null : cm;
      if (!Number.isNaN(cm)) showHeightError(false);
      update();
    });
    input.addEventListener('change', () => showHeightError(Number.isNaN(readHeight())));
  });
  $('fit').addEventListener('input', (e) => { state.fit = FITS[Number(e.target.value)]; update(); });
  $('brand').addEventListener('input', (e) => { state.brand = e.target.value; update(); });

  async function persist(list) {
    if (!hasStorage) return;
    for (const ev of list) await P.dispatch(ev);
  }

  // ---------------------------------------------------------------------------
  // one question at a time

  // Best fit comes before fit, so fit reads as an adjustment to a size you know; height changes nothing yet, so it goes last.
  const STEPS = ['section', 'anchor', 'fit', 'body', 'done'];
  const panels = STEPS.map((k) => document.querySelector(`.q[data-q="${k}"]`));
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE_SOFT = 'cubic-bezier(.22, 1, .36, 1)';
  let step = 0;
  let moving = false;
  let resize = null;

  function renderNav() {
    const name = STEPS[step];
    const last = name === 'body';
    $('step-count').textContent = name === 'done' ? 'All set' : `${step + 1} of 4`;
    $('back').hidden = step === 0 || name === 'done';
    $('next').textContent = last ? 'Finish' : 'Next';
    $('next').disabled = name !== 'done' && !answered()[name];
    document.body.classList.toggle('finished', name === 'done');
    // While choosing a best-fitting piece, photos of that kind stay vivid and the rest fade back.
    $('mosaic').dataset.focus = name === 'anchor' ? state.kind : '';
  }

  async function goTo(next) {
    if (moving || next === step || next < 0 || next >= STEPS.length) return;
    const dir = next > step ? 1 : -1;
    const from = panels[step];
    const to = panels[next];
    const stage = $('stage');
    step = next;
    renderNav();
    if (reduceMotion()) {
      from.hidden = true; to.hidden = false;
      focusPanel(to);
      return;
    }
    moving = true;
    const h0 = stage.offsetHeight;
    if (resize) resize.cancel();
    // Out: the current question softly lifts away and blurs in the direction of travel.
    const out = from.animate(
      [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: `translateY(${-dir * 14}px)`, filter: 'blur(4px)' }],
      { duration: 260, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
    await out.finished;
    from.hidden = true;
    out.cancel();
    to.hidden = false;
    // The sheet eases to the new question's height while its parts arrive one by one.
    const h1 = stage.offsetHeight;
    stage.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 620, easing: EASE_SOFT });
    const parts = Array.from(to.children);
    parts.forEach((el, i) => el.animate(
      [{ opacity: 0, transform: `translateY(${dir * 16}px)`, filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
      { duration: 640, delay: 90 + i * 70, easing: EASE_SOFT, fill: 'backwards' }));
    focusPanel(to);
    setTimeout(() => { moving = false; }, 90 + parts.length * 70);
  }

  function focusPanel(panel) {
    const target = panel.querySelector('[aria-checked="true"], input, button') || panel;
    target.focus({ preventScroll: true });
  }

  function buildSummary() {
    const a = anchorItem();
    const rows = [
      state.section && SECTION_LABEL[state.section],
      state.heightCm && heightText(state.heightCm),
      state.fit && `${FIT_LABEL[state.fit]} fit`,
      a && `${a.brand} ${a.size}`,
    ].filter(Boolean);
    $('summary').innerHTML = rows.length
      ? rows.map((r) => `<li>${r.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</li>`).join('')
      : '<li class="empty">Nothing yet. FittingRoom will ask on product pages when it needs your size.</li>';
  }

  async function advance() {
    if (STEPS[step] !== 'body') { goTo(step + 1); return; }
    $('next').disabled = true;
    try {
      await persist([...events(), { type: 'completeOnboarding' }]);
    } catch (err) {
      $('next').textContent = 'Couldn’t save. Try again';
      $('next').disabled = false;
      throw err;
    }
    buildSummary();
    goTo(step + 1);
  }

  $('next').addEventListener('click', advance);
  $('back').addEventListener('click', () => goTo(step - 1));
  $('skip').addEventListener('click', () => {
    // Skipping drops that answer; skipping the last question also saves the rest.
    if (STEPS[step] === 'anchor') { state.size = null; state.length = null; update(); }
    if (STEPS[step] === 'body') { state.heightCm = null; fillHeight(); showHeightError(false); update(); advance(); return; }
    goTo(step + 1);
  });
  $('edit').addEventListener('click', () => goTo(0));
  $('close').addEventListener('click', () => window.close());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.closest('button') || STEPS[step] === 'done') return;
    if (!$('next').disabled) { e.preventDefault(); advance(); }
  });

  // ---------------------------------------------------------------------------
  // boot: prefill from a saved profile (when reopened to edit)

  function prefill(profile) {
    state.section = profile.section || null;
    if (profile.body && profile.body.heightCm) state.heightCm = profile.body.heightCm;
    state.fit = FITS.includes(profile.preference) ? profile.preference : null;
    const a = P.anchorItem(profile);
    if (a) {
      state.kind = a.category === 'bottom' ? 'bottom' : 'top';
      state.brand = a.brand || '';
      const [w, l] = String(a.size).split(/x/i);
      state.size = w; state.length = l || null;
    }
    $('brand').value = state.brand;
    fillHeight();
    if (state.fit) $('fit').value = FITS.indexOf(state.fit);
  }

  (async function boot() {
    const profile = hasStorage ? await P.load() : P.emptyProfile();
    renderMosaic();
    prefill(profile);
    update();
    renderNav();
    requestAnimationFrame(() => document.body.classList.add('ready'));
  })();
})();
