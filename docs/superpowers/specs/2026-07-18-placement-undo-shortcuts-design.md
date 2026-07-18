# Scene-editor placement undo/redo + keyboard shortcuts

**Date:** 2026-07-18
**Status:** Design — approved for planning
**Scope:** `scene.js` (Scene editor only). No changes to the Character editor (`app.js`).

## Goal

Give the Scene editor's **adv-mode stage placements** a history stack (undo/redo)
and a set of keyboard shortcuts for direct stage manipulation. Placement editing
today is destructive and mouse-only: a mis-drag, an accidental **Reset**, or a
stray **Remove** loses work with no recovery, and every placement tweak requires
the mouse + inspector.

## Non-goals

- **Scene config is out of scope.** Background, author, message text, overlay
  toggles, locale, and trial-camera state are *not* undoable. History tracks
  placement geometry and membership only.
- **Trial mode is out of scope.** Stage placements exist only in `adv` scene
  type (the placement inspector is `data-scene-type="adv"`; `refreshPlacementOverlays`
  early-returns in trial). Trial's stand-slot system is untouched.
- **No history persistence across reloads.** History is in-memory; a page reload
  starts with empty stacks. Placements themselves keep persisting to localStorage
  exactly as today.

## Background: the state being tracked

Placement state in `scene.js` is a small, already-serializable object:

```js
let placements   = [];    // [{ slug, x, y, scale }]
let selectedSlug = null;  // string | null
```

`savePlacements()` already writes `{ version, placements, selectedSlug }` to
localStorage (`PLACEMENTS_KEY`). Every mutation funnels through the same set of
refreshers: `refreshSnapshotList()`, `refreshInspector()`,
`refreshPlacementOverlays()`, `scheduleRender()`, `schedulePlacementsSave()`.

Mutation sites (all in `scene.js`):

| Action | Function / handler |
|---|---|
| Add | `addOrSelectPlacement(slug)` |
| Remove | `removePlacement(slug)` |
| Bring to front | `bringPlacementToFront(slug)` |
| Send to back | `sendPlacementToBack(slug)` |
| Drag-move | `attachPlacementOverlayHandlers` (pointerdown/move/up) |
| Inspector X/Y | `applyScenePosX/Y` via `inspectorX/Y` + `inspectorX/YValue` |
| Inspector scale | `applyScale` via `inspectorScale` + `inspectorScaleValue` |
| Reset all | `resetBtn.onclick` (adv branch sets `placements = []`) |

Because the whole state is a few hundred bytes and cleanly serializable, the
history model is a **full-state snapshot ring** — no per-action inverse logic.

## Design

### 1. History core

A module-level history over `{ placements, selectedSlug }`.

**Data:**

```js
const HISTORY_LIMIT = 100;          // runaway guard; entries are tiny
let undoStack = [];                 // past snapshots (oldest → newest)
let redoStack = [];                 // future snapshots
let pendingBefore = null;           // open-gesture "before" snapshot, or null
```

A snapshot is `structuredClone({ placements, selectedSlug })`. Selection is
captured so undoing a delete restores the character *and* reselects it.

**Gesture API (coalescing):**

- `historyBegin()` — if `pendingBefore` is null, set it to a fresh snapshot of
  the current state. No-op if a gesture is already open (so a burst captures the
  pre-burst state once).
- `historyCommit()` — if `pendingBefore` is set and the current state differs
  from it (deep compare of the serialized form), push `pendingBefore` onto
  `undoStack` (dropping the oldest entry past `HISTORY_LIMIT`) and clear
  `redoStack`. Always clears `pendingBefore`. No entry is pushed if nothing
  changed (e.g. a click that started but didn't move a drag).

**Undo / redo:**

- `undo()` — no-op if `undoStack` empty. Flush any open gesture first
  (`historyCommit()`). Push a snapshot of the *current* state onto `redoStack`,
  pop `undoStack`, and `applyState(popped)`.
- `redo()` — mirror: no-op if `redoStack` empty; push current onto `undoStack`,
  pop `redoStack`, `applyState`.

**`applyState(snapshot)`** — the single restore path:

```js
placements   = structuredClone(snapshot.placements);
selectedSlug = snapshot.selectedSlug;
refreshSnapshotList();
refreshInspector();
refreshPlacementOverlays();
scheduleRender();
schedulePlacementsSave();
updateHistoryButtons();      // see §3
```

**Wiring the mutation sites:**

- Discrete actions wrap the mutation in `historyBegin()` … `historyCommit()`
  synchronously — one step each. Applies to add, remove, bring-to-front,
  send-to-back, reset-all, and a committed inspector-number entry
  (`inspectorXValue/YValue/ScaleValue` `onchange`).
- **Drag:** `historyBegin()` in the pointerdown path (`selectAndStartDrag`, once
  `drag` is established), `historyCommit()` in `endDrag`.
- **Slider drag** (`inspectorX/Y/Scale` range inputs): `historyBegin()` on the
  first `oninput` of a gesture, `historyCommit()` on `onchange` (fires at
  pointer release). The existing "first input opens, change closes" structure
  maps directly — a `gestureOpen` guard on `oninput` avoids re-begin on every
  tick.
- **Arrow nudge:** `historyBegin()` on the first key of a burst; a 600 ms idle
  timer, reset on each nudge, fires `historyCommit()`. Selection is a passenger
  only — selecting a different character never opens or commits a gesture.

**Gesture flushing.** Before any action that starts a new logical operation
while a nudge gesture might be open (drag start, undo, redo, remove, reset,
selecting a different placement, a cross-tab reload), call `historyCommit()`
first so the pending burst becomes its own step and cannot merge across
operations.

### 2. Keyboard shortcuts

A single `document`-level `keydown` listener.

**Suppression guard (first check, always).** If `document.activeElement` is an
`<input>`, `<textarea>`, `<select>`, or has `isContentEditable`, return
immediately and let the browser handle the key. This is deliberate for undo:
when the cursor is in the message box, `Ctrl+Z` must do native *text* undo, not
placement undo.

**Mode gate.** Nudge / delete / z-order require `sceneType === 'adv'` **and** a
resolved `selectedSlug`; they no-op otherwise. Undo/redo are placement-scoped,
so they too only act when `sceneType === 'adv'` (a no-op elsewhere rather than a
surprise).

**Bindings** (`mod` = `e.ctrlKey || e.metaKey`, covering Ctrl and ⌘):

| Keys | Action |
|---|---|
| `mod+Z` (no Shift) | `undo()` |
| `mod+Shift+Z` **or** `mod+Y` | `redo()` |
| `ArrowLeft/Right/Up/Down` | nudge selected ±1 px; `preventDefault()` (stop page scroll) |
| `Shift+Arrow` | nudge ±10 px |
| `Delete` / `Backspace` | `removePlacement(selectedSlug)` |
| `[` / `]` | `sendPlacementToBack` / `bringPlacementToFront` |

**Nudge rendering** mirrors the existing drag optimization: update
`placement.x/y`, move the CSS overlay live (cheap), `refreshInspector()`, and
let the debounced `scheduleRender()` coalesce the canvas repaint so a held arrow
key doesn't queue many ~150–300 ms renders. OS key-repeat drives the burst; the
600 ms idle coalescing (§1) collapses it into one undo step.

### 3. On-screen Undo/Redo buttons

Keyboard shortcuts alone leave touch/mobile users (the app has a mobile drawer,
no physical keyboard) with no undo. Add **Undo** and **Redo** buttons to the
Scene editor's existing `.actions` row (`scene.html`, alongside Reset / Export
PNG). They call the same `undo()` / `redo()` functions.

- `updateHistoryButtons()` sets each button's `disabled` from
  `undoStack.length` / `redoStack.length`. Called after every commit, undo,
  redo, cross-tab reload, and on init.
- Buttons are placement-scoped like the rest: they may be shown in both scene
  types but are disabled whenever there's nothing to undo/redo (which, since
  history only fills in adv mode, means they're inert in trial).

### 4. Edge cases

**Cross-tab reload.** Placements sync via the `storage` listener →
`loadPlacements({ preserveSelection: true })` (and the deferred
`_pendingReload` path on dragend). When another tab's edit lands, the base
state changes underneath us and the in-memory history no longer describes
reachable states. On any external `loadPlacements` triggered by the storage
listener, **flush the pending gesture, then clear both `undoStack` and
`redoStack`** and call `updateHistoryButtons()`. History restarts from the
incoming state. (The init-time `loadPlacements` call is *not* a cross-tab event
and simply starts with empty history — same result.)

**Reset button.** The adv branch of `resetBtn.onclick` becomes one undoable step
(`historyBegin()` before `placements = []`, `historyCommit()` after the
refreshers). An accidental Reset is now recoverable. The trial branch is
untouched.

**Redo invalidation.** Any committed action clears `redoStack` (standard).

**Empty / unchanged gestures.** A pointerdown that selects but doesn't move, or
an arrow burst that nets zero movement, commits no entry (deep-compare guard in
`historyCommit`).

## Testing

- **Unit (pure logic), `node --test`.** Extract the history ring
  (`historyBegin` / `historyCommit` / `undo` / `redo` / limit / redo-clear /
  unchanged-no-op) as a small pure module or exported functions, following the
  `bg_picker.js` precedent (pure logic exported DOM-free, tested by
  `tests/*.test.mjs`). Cover: push/undo/redo round-trip, coalescing (begin once
  + commit once = one entry), unchanged commit is a no-op, limit eviction,
  redo-stack cleared on new commit, cross-tab clear.
- **Manual (documented in the plan).** Drag = one undo; held-arrow burst = one
  undo; Reset then undo restores placements; delete then undo restores +
  reselects; `mod+Z` in the message box does text undo (not placement undo);
  buttons enable/disable correctly; two-tab edit clears history without error.

## Files touched

- `scene.js` — history core, gesture wiring at the eight mutation sites, keydown
  listener, `updateHistoryButtons`, cross-tab clear, reset wrapping. Bump
  `BUILD_VERSION`.
- `scene.html` — two buttons in `.actions`; bump `scene.js?v=` / `styles.css?v=`
  cache-busters in lockstep with `BUILD_VERSION`.
- `styles.css` — minimal; reuse existing `.action-btn`. Disabled state only if
  not already covered.
- `tests/` — new `*.test.mjs` for the history ring.
- Possibly a small new module (e.g. `placement_history.js`) if extracting the
  ring for testability reads cleaner than exporting from `scene.js`.
