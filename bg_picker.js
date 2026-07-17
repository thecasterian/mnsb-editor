// Background picker for the Adv scene editor.
//
// The source backgrounds are 4096x2048 and 5-10 MB each, so the popover
// previews the WebP thumbnails baked by scripts/build_bg_thumbs.py. A native
// <select> can't do this at all: browsers neither fire hover on <option> nor
// render images inside it.
//
// Everything above createBgPicker is pure and DOM-free so it can be tested
// with `node --test tests/bg_picker.test.mjs`. Keep it that way.

/** Groups whose rows match `query`, dropping groups left with no rows.
 *  Rows marked `pinned` (the "(none — black)" entry) always survive. */
export function filterGroups(groups, query) {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out = [];
  for (const g of groups) {
    const items = g.items.filter(i => i.pinned || i.label.toLowerCase().includes(q));
    if (items.length) out.push({ ...g, items });
  }
  return out;
}

/** Every row value in display order. */
export function visibleValues(groups) {
  return groups.flatMap(g => g.items.map(i => i.value));
}

/** The value `delta` rows away from `current`, clamped at both ends.
 *  Clamps rather than wraps, matching a native <select>. When `current` is
 *  absent — nothing active yet, or the active row was just filtered away —
 *  arrowing down starts at the top and arrowing up starts at the bottom. */
export function nextActiveValue(values, current, delta) {
  if (values.length === 0) return null;
  const i = values.indexOf(current);
  if (i === -1) return delta > 0 ? values[0] : values[values.length - 1];
  const next = Math.min(values.length - 1, Math.max(0, i + delta));
  return values[next];
}

/** What a tap on `row` should do, given the current touch `state`.
 *
 *  Touch has no hover, so a tap has to serve two purposes: showing the
 *  preview, and choosing the row. Returns 'preview' or 'commit'.
 *
 *  @param {{previewValue: string|null}} state  value whose popover is showing
 *  @param {{value: string, hasThumb: boolean}} row  the tapped row
 *  @returns {'preview'|'commit'}
 */
export function tapAction(state, row) {
  // Checked first, and deliberately so: a row with nothing to preview has no
  // reason to cost two taps. Folding this into the comparison below would
  // happen to work — previewValue can't match a row that never previewed —
  // but only by accident, and it would break the day a row without a
  // thumbnail gains a preview of its own.
  if (!row.hasThumb) return 'commit';
  return state.previewValue === row.value ? 'commit' : 'preview';
}

// Long enough that dragging the cursor down 60 rows fires one fetch instead of
// 60; short enough to feel immediate on the row you actually stop on.
const HOVER_DELAY_MS = 80;
const GAP = 12;

/** Build the picker inside `mount`.
 *
 *  @param {object}   opts
 *  @param {Element}  opts.mount     element to render into (emptied)
 *  @param {Function} opts.thumbUrl  (value) => url | null; null = nothing to preview
 *  @param {Function} opts.onChange  (value) => void; fires on commit only, never preview
 *  @returns {{setGroups: Function, setValue: Function, getValue: Function}}
 */
export function createBgPicker({ mount, thumbUrl, onChange }) {
  let groups = [];
  let value = '';
  let query = '';
  let activeValue = null;     // highlighted by hover or arrow keys
  let previewValue = null;    // whose popover is up (also the touch tap state)
  let open = false;
  let hoverTimer = null;
  let rowSeq = 0;
  const thumbCache = new Map();
  const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

  mount.classList.add('bg-picker');
  mount.replaceChildren();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bg-picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'bg-picker-panel';
  panel.hidden = true;

  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'bg-picker-filter';
  filter.placeholder = 'Filter…';
  filter.setAttribute('aria-label', 'Filter backgrounds');
  // The listbox is the visual thing being navigated, but focus stays here, and
  // aria-activedescendant is only honored on the focused element — so the combobox
  // semantics and the active-row pointer both belong on the input, not on the list.
  filter.setAttribute('role', 'combobox');
  filter.setAttribute('aria-controls', 'bgp-list');
  filter.setAttribute('aria-expanded', 'false');

  const list = document.createElement('div');
  list.className = 'bg-picker-list';
  list.id = 'bgp-list';
  list.setAttribute('role', 'listbox');

  const pop = document.createElement('div');
  pop.className = 'bg-picker-pop';
  pop.hidden = true;

  panel.append(filter, list);
  mount.append(button, panel, pop);

  // --- helpers ---

  function itemFor(v) {
    for (const g of groups) for (const i of g.items) if (i.value === v) return i;
    return null;
  }

  function labelFor(v) {
    return itemFor(v)?.label ?? v;
  }

  function rowEl(v) {
    return list.querySelector(`[data-value="${CSS.escape(v)}"]`);
  }

  function updateButton() {
    button.textContent = labelFor(value);
  }

  // --- preview ---

  function missingNode() {
    const d = document.createElement('div');
    d.className = 'bg-picker-missing';
    d.textContent = 'no thumbnail — run scripts/build_bg_thumbs.py';
    return d;
  }

  function thumbNode(url) {
    const box = document.createElement('div');
    box.className = 'bg-picker-thumb-box';
    let img = thumbCache.get(url);
    if (!img) {
      img = new Image();
      img.className = 'bg-picker-thumb';
      img.alt = '';
      img.src = url;
      thumbCache.set(url, img);
    }
    if (img.dataset.failed === '1') {
      box.append(missingNode());
      return box;
    }
    img.onerror = () => {
      img.dataset.failed = '1';
      box.replaceChildren(missingNode());
    };
    box.append(img);
    return box;
  }

  function placePop(row) {
    const r = row.getBoundingClientRect();
    pop.hidden = false;                       // must be laid out before measuring
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = window.innerWidth - r.right >= w + GAP + 8
      ? r.right + GAP                          // room on the right
      : r.left - w - GAP;                      // otherwise flip to the left
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.min(Math.max(8, r.top - 8), window.innerHeight - h - 8)}px`;
  }

  function showPreview(v, row) {
    const url = thumbUrl(v);
    if (!url) { hidePreview(); return; }
    const cap = document.createElement('b');
    cap.className = 'bg-picker-caption';
    cap.textContent = labelFor(v);
    pop.replaceChildren(thumbNode(url), cap);
    previewValue = v;
    placePop(row);
  }

  function hidePreview() {
    clearTimeout(hoverTimer);
    previewValue = null;
    pop.hidden = true;
    pop.replaceChildren();
  }

  // --- rendering ---

  function setActive(v) {
    activeValue = v;
    for (const el of list.querySelectorAll('.bg-picker-row')) {
      el.classList.toggle('active', el.dataset.value === v);
    }
    const el = v === null ? null : rowEl(v);
    if (el) filter.setAttribute('aria-activedescendant', el.id);
    else filter.removeAttribute('aria-activedescendant');
  }

  function render() {
    const shown = filterGroups(groups, query);
    list.replaceChildren();
    rowSeq = 0;
    for (const g of shown) {
      if (g.label) {
        const h = document.createElement('div');
        h.className = 'bg-picker-group';
        h.textContent = g.label;
        list.append(h);
      }
      for (const item of g.items) {
        const row = document.createElement('div');
        row.className = 'bg-picker-row';
        row.id = `bgp-row-${rowSeq++}`;
        row.dataset.value = item.value;
        row.textContent = item.label;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(item.value === value));
        row.classList.toggle('selected', item.value === value);
        list.append(row);
      }
    }
    if (!shown.some(g => g.items.some(i => !i.pinned))) {
      const d = document.createElement('div');
      d.className = 'bg-picker-empty';
      d.textContent = 'no matches';
      list.append(d);
    }
    setActive(activeValue);
  }

  // --- open / close / commit ---

  function openPanel() {
    open = true;
    query = '';
    filter.value = '';
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    filter.setAttribute('aria-expanded', 'true');
    activeValue = value;
    render();
    rowEl(value)?.scrollIntoView({ block: 'center' });
    filter.focus();
  }

  function close() {
    open = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    filter.setAttribute('aria-expanded', 'false');
    hidePreview();
  }

  function commit(v) {
    value = v;
    updateButton();
    close();
    onChange(v);
  }

  // --- events ---

  button.addEventListener('click', () => (open ? close() : openPanel()));

  list.addEventListener('mouseover', (e) => {
    if (isCoarse()) return;
    const row = e.target.closest('.bg-picker-row');
    if (!row) return;
    setActive(row.dataset.value);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showPreview(row.dataset.value, row), HOVER_DELAY_MS);
  });

  list.addEventListener('mouseleave', () => {
    if (isCoarse()) return;
    hidePreview();
  });

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.bg-picker-row');
    if (!row) return;
    const v = row.dataset.value;
    if (isCoarse()) {
      const action = tapAction({ previewValue }, { value: v, hasThumb: !!thumbUrl(v) });
      if (action === 'preview') {
        setActive(v);
        showPreview(v, row);
        return;
      }
    }
    commit(v);
  });

  filter.addEventListener('input', () => {
    query = filter.value;
    hidePreview();          // the list changed under it; the old preview is stale
    activeValue = null;
    render();
  });

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); button.focus(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeValue !== null) commit(activeValue);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    clearTimeout(hoverTimer);   // a hover preview armed just before this keypress must not
                                // land after us and repoint the popover at the wrong row
    const next = nextActiveValue(
      visibleValues(filterGroups(groups, query)), activeValue, e.key === 'ArrowDown' ? 1 : -1);
    if (next === null) return;
    setActive(next);
    const row = rowEl(next);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      showPreview(next, row);
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (open && !mount.contains(e.target)) close();
  });

  return {
    setGroups(g) { groups = g; updateButton(); if (open) { hidePreview(); render(); } },
    setValue(v) { value = v ?? ''; updateButton(); if (open) { hidePreview(); render(); } },
    getValue() { return value; },
  };
}
