// Script injected into a page so the user can click its view counter (see teacher.js).
// Kept free of Electron imports so it can be tested in a plain browser.

export const PICK = '__VIEW_COUNTER_PICK__';

// Runs inside the page: highlights hovered elements and reports the clicked one via console.log
export const PICKER_SCRIPT = `(() => {
  if (window.__vcPicker) return;
  window.__vcPicker = true;
  const bar = document.createElement('div');
  bar.id = '__vc_bar';
  bar.textContent = 'Клацніть на число переглядів цієї публікації. Щоб скасувати — закрийте вікно або натисніть Esc.';
  bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:12px 16px;' +
    'background:#2563eb;color:#fff;font:600 15px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none;';
  document.documentElement.appendChild(bar);
  window.__vcHint = (text) => { bar.textContent = text; bar.style.background = '#b45309'; };

  let last = null;
  const mark = (el) => {
    if (last) last.style.outline = last.__vcOutline || '';
    if (el && el !== bar) { el.__vcOutline = el.style.outline; el.style.outline = '3px solid #f59e0b'; }
    last = el;
  };
  document.addEventListener('mouseover', (e) => mark(e.target), true);

  // A selector that should find the same spot on other articles of this site
  const selectorFor = (el) => {
    const parts = [];
    for (let cur = el, i = 0; cur && cur.nodeType === 1 && cur !== document.body && i < 4; cur = cur.parentElement, i++) {
      const classes = [...cur.classList].filter((c) => !/\\d{3,}/.test(c) && c.length < 40).slice(0, 3);
      parts.unshift(cur.tagName.toLowerCase() + classes.map((c) => '.' + CSS.escape(c)).join(''));
    }
    return parts.join(' > ');
  };

  document.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    const selector = selectorFor(el);
    const index = Math.max(0, [...document.querySelectorAll(selector)].indexOf(el));
    console.log('${PICK}' + JSON.stringify({ selector, index, text: el.innerText }));
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') console.log('${PICK}null'); }, true);
})();`;
