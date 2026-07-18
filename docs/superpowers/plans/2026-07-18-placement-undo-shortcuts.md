# Placement Undo/Redo + Keyboard Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Scene editor's adv-mode stage placements an undo/redo history and keyboard shortcuts (nudge, delete, z-order), plus on-screen Undo/Redo buttons.

**Architecture:** A pure, DOM-free history module (`placement_history.js`) implements a full-state snapshot ring with a begin/commit "gesture" API for coalescing continuous motion. `scene.js` owns a single history instance, wires begin/commit at each placement mutation site, restores snapshots through one `applyState` path, and adds a document-level `keydown` listener plus two buttons. Scene config and trial mode are untouched.

**Tech Stack:** Vanilla ES modules, no build step. Unit tests via Node's built-in test runner (`node --test`), following the `bg_picker.js` precedent (pure logic exported, tested DOM-free).

**Reference spec:** `docs/superpowers/specs/2026-07-18-placement-undo-shortcuts-design.md`

---

## File Structure

- **Create** `placement_history.js` — pure history ring (`createHistory`, `snapshotsEqual`). No DOM, no globals. Dynamically imported by `scene.js` like `bg_picker.js`.
- **Create** `tests/placement_history.test.mjs` — unit tests for the ring.
- **Modify** `scene.js` — instantiate history; add `currentPlacementState`, `applyState`, `undoPlacement`, `redoPlacement`, `flushHistory`, `updateHistoryButtons`, `nudgeSelected`; wire begin/commit at the 8 mutation sites + reset + cross-tab clear; add the keydown listener; bump `BUILD_VERSION`.
- **Modify** `scene.html` — add a `.history-actions` row with Undo/Redo buttons; bump the two `?v=` cache-busters.
- **Modify** `styles.css` — add `.history-actions` and a generic `.action-btn:disabled` rule; move `margin-top:auto` from `.actions` to `.history-actions`.

State captured per history entry: `{ placements, selectedSlug }`. Placement objects are `{ slug, x, y, scale }`; `x`/`y` are canvas-pixel top-left (canvas is 2560×1440), `scale` is the placement scale.

---

## Task 1: Pure history ring module + tests

**Files:**
- Create: `placement_history.js`
- Test: `tests/placement_history.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/placement_history.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHistory, snapshotsEqual } from '../placement_history.js';

const S = (placements, selectedSlug = null) => ({ placements, selectedSlug });
const P = (slug, x = 0, y = 0, scale = 1) => ({ slug, x, y, scale });

test('snapshotsEqual compares by value, order-stable', () => {
  assert.equal(snapshotsEqual(S([P('a', 1, 2)]), S([P('a', 1, 2)])), true);
  assert.equal(snapshotsEqual(S([P('a', 1, 2)]), S([P('a', 1, 3)])), false);
  assert.equal(snapshotsEqual(S([], 'a'), S([], 'b')), false);
});

test('begin+commit with a change pushes one undo entry', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  assert.equal(h.canUndo(), true);
  assert.equal(h.canRedo(), false);
});

test('commit with no change pushes nothing', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 0, 0)]));
  assert.equal(h.canUndo(), false);
});

test('commit without an open gesture is a no-op', () => {
  const h = createHistory();
  assert.equal(h.commit(S([P('a', 9, 9)])), false);
  assert.equal(h.canUndo(), false);
});

test('a second begin during an open gesture does not recapture (coalescing)', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));   // captures 0,0
  h.begin(S([P('a', 3, 0)]));   // no-op, still 0,0
  h.commit(S([P('a', 7, 0)]));
  const undone = h.undo(S([P('a', 7, 0)]));
  assert.deepEqual(undone, S([P('a', 0, 0)]));  // restores the pre-burst state
});

test('undo returns the previous snapshot and enables redo', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  const undone = h.undo(S([P('a', 5, 0)]));
  assert.deepEqual(undone, S([P('a', 0, 0)]));
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), true);
});

test('redo returns the future snapshot round-trip', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  h.undo(S([P('a', 5, 0)]));
  const redone = h.redo(S([P('a', 0, 0)]));
  assert.deepEqual(redone, S([P('a', 5, 0)]));
  assert.equal(h.canUndo(), true);
  assert.equal(h.canRedo(), false);
});

test('undo/redo on empty stacks return null', () => {
  const h = createHistory();
  assert.equal(h.undo(S([])), null);
  assert.equal(h.redo(S([])), null);
});

test('a new commit clears the redo stack', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)])); h.commit(S([P('a', 5, 0)]));
  h.undo(S([P('a', 5, 0)]));
  assert.equal(h.canRedo(), true);
  h.begin(S([P('a', 0, 0)])); h.commit(S([P('a', 9, 0)]));
  assert.equal(h.canRedo(), false);
});

test('returned snapshots are decoupled clones', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  const undone = h.undo(S([P('a', 5, 0)]));
  undone.placements[0].x = 999;               // mutate the returned copy
  const redone = h.redo(S([P('a', 0, 0)]));
  assert.equal(redone.placements[0].x, 5);    // stored redo entry unaffected
});

test('undo stack is capped at the limit, dropping oldest', () => {
  const h = createHistory({ limit: 3 });
  for (let i = 1; i <= 5; i++) {
    h.begin(S([P('a', i - 1, 0)]));
    h.commit(S([P('a', i, 0)]));
  }
  // 5 commits, cap 3 → only the last 3 "before" states are retained.
  let s = S([P('a', 5, 0)]);
  const seen = [];
  for (let step; (step = h.undo(s)); ) { seen.push(step.placements[0].x); s = step; }
  assert.deepEqual(seen, [4, 3, 2]);  // oldest (1, 0) evicted
});

test('clear empties both stacks and any open gesture', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)])); h.commit(S([P('a', 5, 0)]));
  h.begin(S([P('a', 5, 0)]));           // leave a gesture open
  h.clear();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.commit(S([P('a', 8, 0)])), false);  // no open gesture after clear
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/placement_history.test.mjs`
Expected: FAIL — cannot resolve `../placement_history.js` (module does not exist).

- [ ] **Step 3: Write the module**

Create `placement_history.js`:

```js
// Pure, DOM-free undo/redo ring for the Scene editor's placement state.
// State is `{ placements, selectedSlug }` — small and JSON-serializable, so
// history is a full-state snapshot stack rather than per-action inverses.
//
// Gesture API (begin/commit) coalesces continuous motion (a drag, a slider
// sweep, an arrow-key burst) into a single undo step: begin captures the
// pre-gesture snapshot once; commit pushes it only if the state actually
// changed. The caller (scene.js) drives the DOM refreshes; this module only
// bookkeeps snapshots.

// Value equality via canonical JSON. Placement objects are always built with
// the same key order ({slug,x,y,scale}) and structuredClone preserves it, so
// stringify comparison is stable.
export function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createHistory({ limit = 100, clone = structuredClone } = {}) {
  let undoStack = [];
  let redoStack = [];
  let pendingBefore = null;

  return {
    // Open a gesture, capturing the current state as its "before". No-op if a
    // gesture is already open (so a burst captures the pre-burst state once).
    begin(state) {
      if (pendingBefore === null) pendingBefore = clone(state);
    },

    // Close the open gesture. Pushes the captured "before" onto the undo stack
    // only if `state` differs from it. Returns true iff an entry was pushed.
    commit(state) {
      if (pendingBefore === null) return false;
      const before = pendingBefore;
      pendingBefore = null;
      if (snapshotsEqual(before, state)) return false;
      undoStack.push(before);
      if (undoStack.length > limit) undoStack.shift();
      redoStack = [];
      return true;
    },

    // Return the snapshot to restore (a fresh clone), or null if nothing to
    // undo. Pushes the caller's current state onto the redo stack.
    undo(currentState) {
      if (undoStack.length === 0) return null;
      redoStack.push(clone(currentState));
      return undoStack.pop();
    },

    redo(currentState) {
      if (redoStack.length === 0) return null;
      undoStack.push(clone(currentState));
      return redoStack.pop();
    },

    clear() {
      undoStack = [];
      redoStack = [];
      pendingBefore = null;
    },

    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/placement_history.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add placement_history.js tests/placement_history.test.mjs
git commit -m "Add pure placement history ring with undo/redo and coalescing"
```

---

## Task 2: Integrate the history core into scene.js

No behavior change yet — this wires the module in and adds the plumbing that later tasks call. The two mutation sites and the keydown listener come next.

**Files:**
- Modify: `scene.js` (import near the other dynamic imports, ~line 11–18; helpers near the placement-persistence block, ~line 425–455)

- [ ] **Step 1: Import the module and create the instance**

In `scene.js`, right after the `bg_picker.js` dynamic import block (the `const { createBgPicker } = await import(...)` around line 16–18), add:

```js
// Placement undo/redo history. Dynamic import mirrors bg_picker.js so the
// BUILD_VERSION query string busts the module cache the same way.
const { createHistory } =
  await import(`./placement_history.js?v=${BUILD_VERSION}`);
const history = createHistory();
```

- [ ] **Step 2: Add the state provider, restore path, flush, and button sync**

In `scene.js`, immediately after the `schedulePlacementsSave` / `schedulePlacementsSave`-related block (after `function schedulePlacementsSave()` and its helpers, around line 455), add:

```js
// --- Placement history plumbing ---
//
// The history module stores snapshots of this object. begin/commit clone
// internally, so passing the live reference is safe.
function currentPlacementState() {
  return { placements, selectedSlug };
}

// Idle timer for coalescing arrow-key nudge bursts into one undo step.
let _nudgeTimer = null;

// Close any open gesture as its own step. Called before starting a new logical
// operation (drag start, undo/redo, remove, reset, cross-tab reload) so a
// pending nudge burst can't merge into the next action. Also cancels the
// nudge idle timer so it doesn't fire a late no-op commit.
function flushHistory() {
  if (_nudgeTimer) { clearTimeout(_nudgeTimer); _nudgeTimer = null; }
  history.commit(currentPlacementState());
}

// The single restore path for undo and redo. Deep-clones the snapshot into the
// live state so later in-place mutations (drag) can't corrupt a stored entry,
// then runs the same refreshers every mutation site uses.
function applyState(snapshot) {
  placements   = structuredClone(snapshot.placements);
  selectedSlug = snapshot.selectedSlug;
  refreshSnapshotList();
  refreshInspector();
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  updateHistoryButtons();
}

function undoPlacement() {
  flushHistory();
  const snap = history.undo(currentPlacementState());
  if (snap) applyState(snap);
}

function redoPlacement() {
  flushHistory();
  const snap = history.redo(currentPlacementState());
  if (snap) applyState(snap);
}

// Reset both stacks (and the nudge timer). Used when the base state changes
// underneath us via a cross-tab reload, invalidating the in-memory history.
function historyClearAll() {
  if (_nudgeTimer) { clearTimeout(_nudgeTimer); _nudgeTimer = null; }
  history.clear();
  updateHistoryButtons();
}

// Reflect stack availability on the on-screen buttons. Guarded so it is safe
// to call before the buttons exist (they are added in scene.html in Task 3).
function updateHistoryButtons() {
  const u = document.getElementById('undoBtn');
  const r = document.getElementById('redoBtn');
  if (u) u.disabled = !history.canUndo();
  if (r) r.disabled = !history.canRedo();
}
```

- [ ] **Step 3: Verify the module loads without breaking the app**

Run: `python3 -m http.server 8080` (in the repo root), open `http://localhost:8080/scene.html`, confirm the scene editor still loads (no console errors about `placement_history.js`). Stop the server.
Expected: Editor loads normally; nothing visually changed yet.

- [ ] **Step 4: Commit**

```bash
git add scene.js
git commit -m "Wire placement history plumbing into scene editor"
```

---

## Task 3: Add on-screen Undo/Redo buttons

**Files:**
- Modify: `scene.html:469` (add `.history-actions` row before `.actions`)
- Modify: `styles.css:523-538` (`.history-actions`, move `margin-top:auto`, `.action-btn:disabled`)
- Modify: `scene.js` (wire `onclick` in the init/wire section)

- [ ] **Step 1: Add the buttons to scene.html**

In `scene.html`, replace the `.actions` block at lines 469–472:

```html
  <div class="actions">
    <button class="action-btn reset-btn" id="resetBtn">Reset</button>
    <button class="action-btn export-btn" id="exportBtn">Export PNG</button>
  </div>
```

with:

```html
  <div class="history-actions">
    <button class="action-btn" id="undoBtn" title="Undo (Ctrl+Z)" disabled>Undo</button>
    <button class="action-btn" id="redoBtn" title="Redo (Ctrl+Shift+Z)" disabled>Redo</button>
  </div>

  <div class="actions">
    <button class="action-btn reset-btn" id="resetBtn">Reset</button>
    <button class="action-btn export-btn" id="exportBtn">Export PNG</button>
  </div>
```

- [ ] **Step 2: Add CSS**

In `styles.css`, change the `.actions` rule (lines 523–528) — remove its `margin-top: auto` — and add a `.history-actions` rule plus a disabled style. Replace:

```css
.actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 12px;
}
```

with:

```css
.history-actions {
  display: flex;
  gap: 8px;
  margin-top: auto;   /* grabs the flex slack so the bottom button block sits together */
  padding-top: 12px;
}
.actions {
  display: flex;
  gap: 8px;
  padding-top: 8px;
}
.action-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
```

The `.history-actions` row (Undo/Redo, `.action-btn` with no colored variant) inherits the neutral base `.action-btn` look — a plain rounded button, consistent with the panel.

- [ ] **Step 3: Wire the button clicks**

In `scene.js`, find the init/wire block where `document.getElementById('exportBtn').onclick = exportPng;` is set (~line 4632). Immediately after that line add:

```js
  document.getElementById('undoBtn').onclick = undoPlacement;
  document.getElementById('redoBtn').onclick = redoPlacement;
  updateHistoryButtons();
```

- [ ] **Step 4: Verify buttons render disabled**

Run: `python3 -m http.server 8080`, open `http://localhost:8080/scene.html`. Confirm an Undo/Redo row appears above Reset/Export, both greyed/disabled (nothing pushes history yet). Stop the server.
Expected: Two disabled buttons present, bottom button block grouped together.

- [ ] **Step 5: Commit**

```bash
git add scene.html styles.css scene.js
git commit -m "Add Undo/Redo buttons to the scene editor"
```

---

## Task 4: Wire begin/commit at the placement mutation sites

After this task, undo/redo works via the buttons. Each site opens a gesture, mutates, then commits; the drag opens on pointerdown and commits on pointerup.

**Files:**
- Modify: `scene.js` — `addOrSelectPlacement`, `removePlacement`, `bringPlacementToFront`, `sendPlacementToBack` (~3390–3445); drag handlers (~3872, ~3905); inspector handlers (~4692–4790); reset handler adv branch (~4585–4596); storage listener + `_pendingReload` path (~3910, ~4636)

- [ ] **Step 1: Add — history only on the add branch**

In `addOrSelectPlacement` (~3390), wrap only the new-placement path (selecting an existing placement must not create a step). Replace:

```js
  let placement = placementBySlug(slug);
  let added = false;
  if (!placement) {
    placement = defaultPlacementFor(snap);
    placements.push(placement);
    added = true;
  }
  selectedSlug = slug;
  refreshSnapshotList();
  refreshInspector();
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  return added;
```

with:

```js
  let placement = placementBySlug(slug);
  let added = false;
  if (!placement) {
    flushHistory();
    history.begin(currentPlacementState());
    placement = defaultPlacementFor(snap);
    placements.push(placement);
    added = true;
  }
  selectedSlug = slug;
  refreshSnapshotList();
  refreshInspector();
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  if (added) { history.commit(currentPlacementState()); updateHistoryButtons(); }
  return added;
```

- [ ] **Step 2: Remove**

In `removePlacement` (~3409), wrap the mutation. Replace:

```js
function removePlacement(slug) {
  const before = placements.length;
  placements = placements.filter(p => p.slug !== slug);
  if (selectedSlug === slug) selectedSlug = null;
  if (placements.length !== before) {
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    scheduleRender();
    schedulePlacementsSave();
  }
}
```

with:

```js
function removePlacement(slug) {
  const before = placements.length;
  if (!placements.some(p => p.slug === slug)) return;
  flushHistory();
  history.begin(currentPlacementState());
  placements = placements.filter(p => p.slug !== slug);
  if (selectedSlug === slug) selectedSlug = null;
  if (placements.length !== before) {
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    scheduleRender();
    schedulePlacementsSave();
  }
  history.commit(currentPlacementState());
  updateHistoryButtons();
}
```

- [ ] **Step 3: Z-order (front + back)**

In `bringPlacementToFront` (~3425), after the no-op guard, wrap the splice. Replace:

```js
function bringPlacementToFront(slug) {
  const i = placements.findIndex(p => p.slug === slug);
  if (i < 0 || i === placements.length - 1) return false;
  const [target] = placements.splice(i, 1);
  placements.push(target);
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  return true;
}
```

with:

```js
function bringPlacementToFront(slug) {
  const i = placements.findIndex(p => p.slug === slug);
  if (i < 0 || i === placements.length - 1) return false;
  flushHistory();
  history.begin(currentPlacementState());
  const [target] = placements.splice(i, 1);
  placements.push(target);
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  history.commit(currentPlacementState());
  updateHistoryButtons();
  return true;
}
```

In `sendPlacementToBack` (~3436), do the mirror. Replace:

```js
function sendPlacementToBack(slug) {
  const i = placements.findIndex(p => p.slug === slug);
  if (i <= 0) return false;
  const [target] = placements.splice(i, 1);
  placements.unshift(target);
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  return true;
}
```

with:

```js
function sendPlacementToBack(slug) {
  const i = placements.findIndex(p => p.slug === slug);
  if (i <= 0) return false;
  flushHistory();
  history.begin(currentPlacementState());
  const [target] = placements.splice(i, 1);
  placements.unshift(target);
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  history.commit(currentPlacementState());
  updateHistoryButtons();
  return true;
}
```

- [ ] **Step 4: Drag — open on pointerdown, commit on pointerup**

In `attachPlacementOverlayHandlers`, in `selectAndStartDrag`, the block builds `drag = { ... }` then sets `_dragInProgress = true;` (~3872). Replace that trailing line:

```js
    _dragInProgress = true;
```

with:

```js
    flushHistory();
    history.begin(currentPlacementState());
    _dragInProgress = true;
```

Then in `endDrag` (~3905), the current body is:

```js
  function endDrag(e) {
    const wasDragging = drag && e.pointerId === drag.pointerId;
    if (wasDragging) drag = null;
    _dragInProgress = false;
    if (_pendingReload) {
      _pendingReload = false;
      loadPlacements({ preserveSelection: true });
    }
    if (wasDragging) scheduleRender();  // commit the moved character to pixels
  }
```

Replace it with (commit the drag gesture; a cross-tab reload during the drag clears history instead):

```js
  function endDrag(e) {
    const wasDragging = drag && e.pointerId === drag.pointerId;
    if (wasDragging) drag = null;
    _dragInProgress = false;
    if (_pendingReload) {
      _pendingReload = false;
      loadPlacements({ preserveSelection: true });
      historyClearAll();               // base changed cross-tab; drop history
    } else if (wasDragging) {
      history.commit(currentPlacementState());
      updateHistoryButtons();
    }
    if (wasDragging) scheduleRender();  // commit the moved character to pixels
  }
```

- [ ] **Step 5: Inspector controls — one gesture per edit**

In the inspector-wiring block (~4692), add a small gesture helper and open/close it around the live-edit / commit events. Directly above `const inspectorX = document.getElementById('inspectorX');` (~4692), add:

```js
  // One undo step per inspector edit. `begin` runs on the first live change
  // (before the value is applied, so it captures the pre-edit state); `end`
  // runs on the control's `change` event (slider release / number commit).
  let _inspectorGesture = false;
  function beginInspectorGesture() {
    if (_inspectorGesture) return;
    flushHistory();
    history.begin(currentPlacementState());
    _inspectorGesture = true;
  }
  function endInspectorGesture() {
    if (!_inspectorGesture) return;
    _inspectorGesture = false;
    history.commit(currentPlacementState());
    updateHistoryButtons();
  }
```

Then edit the six inspector handlers. Add `beginInspectorGesture();` as the first statement of each `oninput` handler, and `endInspectorGesture();` as the last statement of each `onchange` handler. The resulting handlers (~4712–4790):

```js
  inspectorX.oninput = (e) => {
    beginInspectorGesture();
    const v = Number(e.target.value) || 0;
    inspectorXNum.value = v;
    applyScenePosX(v);
  };
  inspectorX.onchange = () => { scheduleRender(); endInspectorGesture(); };
  inspectorXNum.oninput = (e) => {
    beginInspectorGesture();
    const v = Number(e.target.value) || 0;
    inspectorX.value = v;
    applyScenePosX(v);
  };
  inspectorXNum.onchange = (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    e.target.value = v;
    inspectorX.value = v;
    applyScenePosX(v);
    scheduleRender();
    endInspectorGesture();
  };
  inspectorY.oninput = (e) => {
    beginInspectorGesture();
    const v = Number(e.target.value) || 0;
    inspectorYNum.value = v;
    applyScenePosY(v);
  };
  inspectorY.onchange = () => { scheduleRender(); endInspectorGesture(); };
  inspectorYNum.oninput = (e) => {
    beginInspectorGesture();
    const v = Number(e.target.value) || 0;
    inspectorY.value = v;
    applyScenePosY(v);
  };
  inspectorYNum.onchange = (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    e.target.value = v;
    inspectorY.value = v;
    applyScenePosY(v);
    scheduleRender();
    endInspectorGesture();
  };
```

And the scale handlers (~4772–4790):

```js
  inspectorScale.oninput = (e) => {
    beginInspectorGesture();
    const v = clampScale(Number(e.target.value));
    inspectorScaleNum.value = v.toFixed(2);
    applyScale(v);
  };
  inspectorScale.onchange = () => { scheduleRender(); endInspectorGesture(); };
  inspectorScaleNum.oninput = (e) => {
    beginInspectorGesture();
    const v = clampScale(Number(e.target.value));
    inspectorScale.value = v;
    applyScale(v);
  };
  inspectorScaleNum.onchange = (e) => {
    const v = clampScale(Number(e.target.value));
    e.target.value = v.toFixed(2);
    inspectorScale.value = v;
    applyScale(v);
    scheduleRender();
    endInspectorGesture();
  };
```

- [ ] **Step 6: Reset — one undoable step (adv branch)**

In `resetBtn.onclick`, the adv branch (~4585) ends with:

```js
    placements = [];
    selectedSlug = null;
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    scheduleRender();
    schedulePlacementsSave();
    scheduleSceneConfigSave();
  };
```

Replace it with:

```js
    flushHistory();
    history.begin(currentPlacementState());
    placements = [];
    selectedSlug = null;
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    scheduleRender();
    schedulePlacementsSave();
    scheduleSceneConfigSave();
    history.commit(currentPlacementState());
    updateHistoryButtons();
  };
```

(The trial branch `return`s earlier and is untouched — it has no placements.)

- [ ] **Step 7: Cross-tab reload clears history**

In the `storage` listener (~4636), the placements branch is:

```js
    if (e.key === PLACEMENTS_KEY) {
      if (_dragInProgress) { _pendingReload = true; return; }
      loadPlacements({ preserveSelection: true });
    } else if (e.key === SCENE_CONFIG_KEY) {
```

Replace the placements branch with:

```js
    if (e.key === PLACEMENTS_KEY) {
      if (_dragInProgress) { _pendingReload = true; return; }
      loadPlacements({ preserveSelection: true });
      historyClearAll();   // another tab changed the base state; drop history
    } else if (e.key === SCENE_CONFIG_KEY) {
```

(The mid-drag deferred case was already handled in Task 4 Step 4's `endDrag`.)

- [ ] **Step 8: Manual verification**

Run: `python3 -m http.server 8080`, open `http://localhost:8080/scene.html` in adv mode with at least one snapshot in the library. Verify:
- Place a character → Undo enables. Click Undo → character removed; Redo enables. Click Redo → character back.
- Drag a character across the stage, release → **one** Undo reverts the whole drag to the start point.
- Drag the scale slider, release → one Undo reverts scale.
- Bring to front / send to back → one Undo each.
- Click Reset (confirm) → one Undo restores all placements.
Stop the server.
Expected: All behaviors as described; no console errors.

- [ ] **Step 9: Commit**

```bash
git add scene.js
git commit -m "Record placement mutations in undo history"
```

---

## Task 5: Keyboard shortcuts + arrow-key nudge

**Files:**
- Modify: `scene.js` — add `nudgeSelected` near the history plumbing (after Task 2's block, ~455); add the `keydown` listener in the init/wire section (near the `storage`/`resize` listeners, ~4636)

- [ ] **Step 1: Add the nudge helper**

In `scene.js`, directly after the `updateHistoryButtons` function added in Task 2 Step 2, add:

```js
// Move the selected placement by (dx, dy) canvas pixels. Coalesces a burst of
// nudges (held arrow key → OS key-repeat) into one undo step via a 600 ms idle
// timer, mirroring how a drag is one step. Canvas is 2560×1440, so step 1 is a
// fine nudge and Shift's step 10 is coarse.
function nudgeSelected(dx, dy) {
  if (sceneType !== 'adv') return;
  const p = selectedSlug ? placementBySlug(selectedSlug) : null;
  if (!p) return;
  if (_nudgeTimer) {
    clearTimeout(_nudgeTimer);
  } else {
    flushHistory();
    history.begin(currentPlacementState());
  }
  p.x = Math.round(p.x + dx);
  p.y = Math.round(p.y + dy);
  refreshPlacementOverlays();
  refreshInspector();
  scheduleRender();
  schedulePlacementsSave();
  _nudgeTimer = setTimeout(() => {
    _nudgeTimer = null;
    history.commit(currentPlacementState());
    updateHistoryButtons();
  }, 600);
}
```

- [ ] **Step 2: Add the keydown listener**

In `scene.js`, in the init/wire section next to the `window.addEventListener('storage', …)` / `window.addEventListener('resize', …)` block (~4636), add:

```js
  // Placement keyboard shortcuts. Suppressed while a text/select control is
  // focused (so Ctrl+Z does native text undo in the message box, arrows move
  // the caret, etc.). Nudge/delete/z-order act on the selected placement and
  // only in adv mode; undo/redo are placement-scoped so they no-op elsewhere.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (t && t.isContentEditable)) return;

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoPlacement(); else undoPlacement();
      return;
    }
    if (mod && key === 'y') { e.preventDefault(); redoPlacement(); return; }
    if (mod) return;   // leave other Ctrl/Cmd combos to the browser

    if (sceneType !== 'adv') return;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); nudgeSelected(-step, 0); break;
      case 'ArrowRight': e.preventDefault(); nudgeSelected(step, 0);  break;
      case 'ArrowUp':    e.preventDefault(); nudgeSelected(0, -step); break;
      case 'ArrowDown':  e.preventDefault(); nudgeSelected(0, step);  break;
      case 'Delete':
      case 'Backspace':
        if (selectedSlug) { e.preventDefault(); removePlacement(selectedSlug); }
        break;
      case '[':
        if (selectedSlug) { e.preventDefault(); if (sendPlacementToBack(selectedSlug)) refreshInspector(); }
        break;
      case ']':
        if (selectedSlug) { e.preventDefault(); if (bringPlacementToFront(selectedSlug)) refreshInspector(); }
        break;
    }
  });
```

- [ ] **Step 3: Manual verification**

Run: `python3 -m http.server 8080`, open `http://localhost:8080/scene.html` in adv mode, place a character and select it. Verify:
- Arrow keys move it 1px; Shift+Arrow moves 10px. Holding an arrow glides it, and **one** Undo reverts the whole burst (pause ~1s first so the burst closes).
- `Delete` / `Backspace` removes it; Undo restores it selected.
- `[` sends to back, `]` brings to front (place two overlapping characters to see it).
- `Ctrl/Cmd+Z` undoes, `Ctrl/Cmd+Shift+Z` and `Ctrl/Cmd+Y` redo.
- Click into the Message textarea, type, press `Ctrl+Z` → it undoes the **text**, not a placement. Arrow keys move the text caret, not the character.
Stop the server.
Expected: All behaviors as described.

- [ ] **Step 4: Commit**

```bash
git add scene.js
git commit -m "Add placement keyboard shortcuts and arrow-key nudge"
```

---

## Task 6: Version bump + final verification

**Files:**
- Modify: `scene.js:3` (`BUILD_VERSION`)
- Modify: `scene.html:10,521` (two `?v=` cache-busters)

- [ ] **Step 1: Bump BUILD_VERSION**

In `scene.js` line 3, change:

```js
const BUILD_VERSION = '20260718a';
```

to:

```js
const BUILD_VERSION = '20260718b';
```

- [ ] **Step 2: Bump the matching cache-busters in scene.html**

In `scene.html` line 10, change `styles.css?v=20260718a` to `styles.css?v=20260718b`.
In `scene.html` line 521, change `scene.js?v=20260718a` to `scene.js?v=20260718b`.

- [ ] **Step 3: Run the full test suite**

Run: `node --test tests/placement_history.test.mjs && node --test tests/bg_picker.test.mjs && python3 -m pytest tests/ -q`
Expected: All pass — the new history tests, the existing bg picker tests, and the Python script tests.

- [ ] **Step 4: Final smoke test in the browser**

Run: `python3 -m http.server 8080`, hard-reload `http://localhost:8080/scene.html` (to bust cache). Confirm the full flow once more: place two characters, drag/scale/reorder/nudge, undo back to empty, redo forward, then switch to trial mode and confirm undo/redo buttons are inert (disabled) and no shortcuts fire there. Stop the server.
Expected: Clean end-to-end behavior; no console errors.

- [ ] **Step 5: Commit**

```bash
git add scene.js scene.html
git commit -m "Bump scene editor build version for undo/redo release"
```

---

## Self-Review notes (for the implementer)

- **Coalescing correctness:** `history.begin` is idempotent while a gesture is open, so bursts (slider ticks, nudge repeats) capture the pre-gesture state exactly once. `flushHistory()` before each new logical operation prevents a pending nudge burst from merging into the next action.
- **No aliasing:** `applyState` deep-clones the restored snapshot into live `placements`; the module clones on `begin`/`undo`/`redo`. A stored entry can never be mutated by later drags.
- **Selection is a passenger:** only the add branch of `addOrSelectPlacement` records history; plain selection (clicking a row or overlay) does not. Selection still rides inside every recorded snapshot, so undoing a delete reselects the restored character.
- **Text-field guard first:** the keydown handler returns before any placement logic when a form control is focused, keeping native text undo/caret behavior intact.
