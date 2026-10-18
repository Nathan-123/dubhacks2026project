'use strict';

/*
 * A dropdown in the FittingRoom style over a native <select>. The select stays the source of truth:
 * picking an option sets its value and fires its "change", so existing handlers keep working.
 * Call refresh() after setting the select's value in code.
 *
 * Keyboard: Enter, Space or ArrowDown opens; arrows move; Enter picks; Escape or Tab closes.
 */
(function (root) {
  let uid = 0;

  function enhance(select) {
    const id = `menu-${++uid}`;
    const wrap = document.createElement('div');
    wrap.className = 'menu-select';
    select.after(wrap);
    wrap.append(select);
    select.hidden = true;
    select.tabIndex = -1;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);
    if (select.getAttribute('aria-labelledby')) button.setAttribute('aria-labelledby', `${select.getAttribute('aria-labelledby')} ${id}-value`);
    button.innerHTML = `<span id="${id}-value"></span>`;

    const list = document.createElement('ul');
    list.className = 'menu-list';
    list.id = id;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const options = [...select.options];
    list.innerHTML = options.map((o, i) => `<li role="option" id="${id}-${i}" data-i="${i}">${o.textContent}</li>`).join('');
    const items = [...list.children];
    wrap.append(button, list);

    let active = 0;
    function refresh() {
      const i = Math.max(0, select.selectedIndex);
      button.firstChild.textContent = options[i].textContent;
      items.forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    }
    function highlight(i) {
      active = (i + items.length) % items.length;
      items.forEach((li, j) => li.classList.toggle('active', j === active));
      list.setAttribute('aria-activedescendant', items[active].id);
    }
    function open() {
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      highlight(Math.max(0, select.selectedIndex));
      list.focus();
    }
    function close(refocus) {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (refocus) button.focus();
    }
    function pick(i) {
      if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      refresh();
      close(true);
    }

    list.tabIndex = -1;
    button.addEventListener('click', () => (list.hidden ? open() : close(true)));
    button.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
    });
    list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) pick(Number(li.dataset.i)); });
    list.addEventListener('mousemove', (e) => { const li = e.target.closest('[data-i]'); if (li) highlight(Number(li.dataset.i)); });
    list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
      else if (e.key === 'Home') { e.preventDefault(); highlight(0); }
      else if (e.key === 'End') { e.preventDefault(); highlight(items.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close(false);
    });
    document.addEventListener('mousedown', (e) => { if (!list.hidden && !wrap.contains(e.target)) close(false); });

    refresh();
    return { refresh };
  }

  (root.FitKit = root.FitKit || {}).select = { enhance };
})(typeof globalThis !== 'undefined' ? globalThis : this);
