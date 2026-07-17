# Hide UI Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Hide UI" toggle to the scene editor that renders a clean stage — background and characters only, with all in-scene game UI suppressed — and honors that in Export PNG.

**Architecture:** One module-level boolean `uiHidden` gates the overlay-composite passes in the two render entry points (`renderScene` for adv, `renderTrialScene` for trial). It is non-destructive (the per-overlay toggle flags are untouched), persisted in the existing `manosaba.scene.config` localStorage record, and surfaced by a button in the panel's `.actions` row plus a CSS greying of the overlay switches.

**Tech Stack:** Vanilla ES-module JS (`scene.js`), plain HTML (`scene.html`), CSS (`styles.css`). No build step — served with `python3 -m http.server 8080`. No framework, no bundler.

---

## Background for the implementer

The scene editor composites its preview onto a canvas pixel buffer in two functions:

- `renderScene()` (adv scene type) — draws the background, then each character placement, then loops over `sceneMeta.prefabs` to composite the dialog frame + overlay UI.
- `renderTrialScene()` (trial scene type) — renders a 3D courtroom + character billboards to `mirror`, then (for the `adv` and `debate` subtypes) composites overlay UI on top.

`exportPng()` calls these same two functions, so gating the overlay passes automatically makes export match the preview — no separate export code.

"Overlay UI" here means the dialog frame, author plate, message/testimony text, the auto-toggle / menu / witch-book buttons, and the debate HUD (clock, timer, fast button, trial-choice screen). It does **not** mean the editor's own left-panel controls, and it never touches the background or the character placements/billboards.

There is **no meaningful pure-logic unit to unit-test** here: the change is boolean short-circuits in render functions plus DOM class toggles. The repo only unit-tests pure, DOM-free helpers (`bg_picker.js` via `tests/bg_picker.test.mjs`); view/render wiring like this is verified by running the app. So this plan verifies each task by serving the editor and checking behavior in the browser, and the final task runs the existing test suites to confirm nothing regressed.

**Important — asset cache-busting:** `scene.html` loads `styles.css?v=<BUILD_VERSION>` and `scene.js?v=<BUILD_VERSION>`, and `scene.js` declares `const BUILD_VERSION`. The three must stay in sync. Because this plan edits all three files, Task 6 bumps the version so a browser doesn't serve stale cached CSS/JS. **Until Task 6, test with a hard reload (Ctrl-Shift-R) or a private window** so you see your edits despite the unchanged `?v=` string.

---

## File structure

| File | Change |
|---|---|
| `scene.html` | Add the `Hide UI` button to `.actions`; tag the three "Overlays" `.field` blocks with `data-overlay-toggles`; bump the two `?v=` query strings (Task 6). |
| `styles.css` | Add `.hide-ui-btn` / `.hide-ui-btn.active` button styles and the `.panel.ui-hidden [data-overlay-toggles]` greying rule. |
| `scene.js` | Add `uiHidden` state + `applyUiHiddenState()` helper; wire the button; gate the two render passes; save/restore `uiHidden`; reset it; bump `BUILD_VERSION` (Task 6). |

---

## Task 1: Markup and styles for the button

**Files:**
- Modify: `scene.html:466-469` (the `.actions` row) and the three "Overlays" `.field` blocks
- Modify: `styles.css:549` (after the `.export-btn:hover` rule)

- [ ] **Step 1: Add the button to the actions row**

In `scene.html`, replace:

```html
  <div class="actions">
    <button class="action-btn reset-btn" id="resetBtn">Reset</button>
    <button class="action-btn export-btn" id="exportBtn">Export PNG</button>
  </div>
```

with:

```html
  <div class="actions">
    <button class="action-btn hide-ui-btn" id="hideUiBtn">Hide UI</button>
    <button class="action-btn reset-btn" id="resetBtn">Reset</button>
    <button class="action-btn export-btn" id="exportBtn">Export PNG</button>
  </div>
```

- [ ] **Step 2: Tag the adv "Overlays" field**

In `scene.html`, replace:

```html
  <div class="field" data-scene-type="adv">
    <div class="section-label">Overlays</div>
```

with:

```html
  <div class="field" data-scene-type="adv" data-overlay-toggles>
    <div class="section-label">Overlays</div>
```

- [ ] **Step 3: Tag the trial-adv "Overlays" field**

In `scene.html`, replace:

```html
  <div class="field" data-scene-type="trial" data-trial-subtype="adv">
    <div class="section-label">Overlays</div>
```

with:

```html
  <div class="field" data-scene-type="trial" data-trial-subtype="adv" data-overlay-toggles>
    <div class="section-label">Overlays</div>
```

- [ ] **Step 4: Tag the trial-debate "Overlays" field**

In `scene.html`, replace:

```html
  <div class="field" data-scene-type="trial" data-trial-subtype="debate">
    <div class="section-label">Overlays</div>
```

with:

```html
  <div class="field" data-scene-type="trial" data-trial-subtype="debate" data-overlay-toggles>
    <div class="section-label">Overlays</div>
```

- [ ] **Step 5: Add the CSS**

In `styles.css`, immediately after the line `.export-btn:hover { background: #ff8266; }` (line 549), add:

```css

.hide-ui-btn { background: var(--bg-card); color: var(--text-muted); border: 1px solid var(--border); }
.hide-ui-btn:hover { background: #333338; color: var(--text); }
.hide-ui-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent);
}

/* While "Hide UI" is engaged, the individual overlay switches have no effect —
   dim them and block interaction so that's obvious. */
.panel.ui-hidden [data-overlay-toggles] {
  opacity: 0.4;
  pointer-events: none;
}
```

- [ ] **Step 6: Verify visually**

Run: `python3 -m http.server 8080` (from the repo root), open `http://localhost:8080/scene.html`, hard-reload (Ctrl-Shift-R).
Expected: a third button labeled **Hide UI** appears in the bottom actions row, styled like the neutral Reset button. Clicking it does nothing yet (no handler). No console errors.

- [ ] **Step 7: Commit**

```bash
git add scene.html styles.css
git commit -m "Add Hide UI button markup and styles"
```

---

## Task 2: State flag, apply helper, and button wiring

**Files:**
- Modify: `scene.js:176` (state declaration), `scene.js:541` (define helper before `loadSceneConfig`), `scene.js:4430` (button wiring before the reset handler)

- [ ] **Step 1: Declare the `uiHidden` state flag**

In `scene.js`, replace:

```javascript
let showAuthorPlate = true;
// Mirror set for trial-with-adv-overlays.
```

with:

```javascript
let showAuthorPlate = true;
// "Hide UI" master view mode: when true, every render skips all in-scene UI
// overlays (dialog frame, plates, buttons, timer, testimony, trial-choice
// screen), leaving just the background + character placements/billboards.
// Non-destructive — the individual overlay flags above are untouched, so
// turning it back off restores exactly what was showing before. Persisted in
// the scene config; scene-type-independent (one flag covers adv + trial).
let uiHidden = false;
// Mirror set for trial-with-adv-overlays.
```

- [ ] **Step 2: Define the `applyUiHiddenState` helper**

In `scene.js`, immediately before the comment block that precedes `function loadSceneConfig(...)`, i.e. replace:

```javascript
// Apply a saved-config record to the in-memory state and corresponding DOM
// controls. `render=true` (the default) schedules a re-render; init passes
// false because it does its own initial render after this returns.
function loadSceneConfig({ render = true } = {}) {
```

with:

```javascript
// Sync the "Hide UI" button's active state and the panel's `ui-hidden` class
// (which greys the overlay switches) to the current `uiHidden` flag. Called
// from the button handler, from loadSceneConfig on restore, and from reset.
// Declared at module scope (not inside init) so loadSceneConfig can call it.
function applyUiHiddenState() {
  document.getElementById('hideUiBtn').classList.toggle('active', uiHidden);
  document.querySelector('.panel').classList.toggle('ui-hidden', uiHidden);
}

// Apply a saved-config record to the in-memory state and corresponding DOM
// controls. `render=true` (the default) schedules a re-render; init passes
// false because it does its own initial render after this returns.
function loadSceneConfig({ render = true } = {}) {
```

- [ ] **Step 3: Wire the button**

In `scene.js`, immediately before the reset handler, i.e. replace:

```javascript
  document.getElementById('resetBtn').onclick = async () => {
    if (!await showModal('Reset all customizations to default?')) return;
```

with:

```javascript
  // "Hide UI" toggle: master view mode that hides all in-scene overlays,
  // leaving background + characters. Non-destructive and persisted.
  document.getElementById('hideUiBtn').onclick = () => {
    uiHidden = !uiHidden;
    applyUiHiddenState();
    scheduleRender();
    scheduleSceneConfigSave();
  };

  document.getElementById('resetBtn').onclick = async () => {
    if (!await showModal('Reset all customizations to default?')) return;
```

- [ ] **Step 4: Verify the button toggles state**

Reload `scene.html` (hard reload). Click **Hide UI**.
Expected: the button gains the coral active outline; the "Overlays" switch group dims and stops responding to clicks. Click again → button returns to neutral, switches un-dim and work again. The preview does **not** change yet (render gating comes in Task 3). No console errors.

- [ ] **Step 5: Commit**

```bash
git add scene.js
git commit -m "Wire Hide UI button state and overlay greying"
```

---

## Task 3: Gate the render passes

**Files:**
- Modify: `scene.js` `renderScene()` (the `sceneMeta.prefabs` loop after the placements loop) and `renderTrialScene()` (right after the early `return mirror` guard)

- [ ] **Step 1: Gate the adv overlay loop in `renderScene`**

In `scene.js`, replace:

```javascript
  for (const p of placements) await renderPlacement(p, dst);

  for (const prefab of sceneMeta.prefabs) {
    if (prefab.toggle && !isFlagOn(prefab.toggle)) continue;
    for (const [, kind, item] of selectPrefabItems(prefab)) {
      if (kind === 'layer') await renderLayer(item, dst);
      else                  await renderTextLeaf(item, dst);
    }
  }
```

with:

```javascript
  for (const p of placements) await renderPlacement(p, dst);

  // "Hide UI": skip all in-scene overlays, leaving the background +
  // placements already composited above.
  if (!uiHidden) {
    for (const prefab of sceneMeta.prefabs) {
      if (prefab.toggle && !isFlagOn(prefab.toggle)) continue;
      for (const [, kind, item] of selectPrefabItems(prefab)) {
        if (kind === 'layer') await renderLayer(item, dst);
        else                  await renderTextLeaf(item, dst);
      }
    }
  }
```

- [ ] **Step 2: Gate the trial overlay passes in `renderTrialScene`**

The trial function renders the 3D courtroom + billboards into `mirror`, then composites overlays for the `adv`/`debate` subtypes. A single early return after the existing subtype guard skips every trial overlay pass (both subtypes) and returns the bare courtroom + billboards.

In `scene.js`, replace:

```javascript
  if (trialSubtype !== 'adv' && trialSubtype !== 'debate') return mirror;

  await ensureFontsLoaded();
```

with:

```javascript
  if (trialSubtype !== 'adv' && trialSubtype !== 'debate') return mirror;
  // "Hide UI": skip every overlay pass (adv dialog frame, or the debate
  // testimony / trial-choice screen / HUD) and return the bare 3D courtroom
  // + character billboards.
  if (uiHidden) return mirror;

  await ensureFontsLoaded();
```

- [ ] **Step 3: Verify hiding works in all three scene modes**

Reload `scene.html` (hard reload). For each of: **Adv**, **Trial → Adv** subtype, **Trial → Debate** subtype:
1. Confirm the full UI renders with Hide UI off.
2. Click **Hide UI** → only the background (or 3D courtroom) and any placed characters remain; the dialog frame, text, buttons, and debate HUD all disappear.
3. Click **Hide UI** off → everything returns exactly as before (verify a previously-hidden individual overlay, e.g. toggle "Menu" off first, then Hide-UI on/off, and confirm Menu is still off — non-destructive).

Expected: overlays vanish and reappear cleanly; no console errors.

- [ ] **Step 4: Verify Export PNG honors it**

With **Hide UI** on and a background + at least one character placed, click **Export PNG**.
Expected: the downloaded PNG shows only the background + character(s), no UI.

- [ ] **Step 5: Commit**

```bash
git add scene.js
git commit -m "Gate scene and trial overlay rendering behind Hide UI flag"
```

---

## Task 4: Persist the flag across reloads

**Files:**
- Modify: `scene.js` `saveSceneConfig()` payload and `loadSceneConfig()` restore block

- [ ] **Step 1: Save `uiHidden`**

In `scene.js`, inside the `saveSceneConfig()` payload, replace:

```javascript
      bgPath,
      authorId,
      messageText,
```

with:

```javascript
      bgPath,
      authorId,
      messageText,
      // "Hide UI" master view mode (scene-type-independent).
      uiHidden,
```

- [ ] **Step 2: Restore `uiHidden`**

In `scene.js`, at the end of `loadSceneConfig()`, replace:

```javascript
  renderTrialChoiceList();

  if (render) scheduleRender();
}
```

with:

```javascript
  renderTrialChoiceList();

  // "Hide UI" master view mode. Absent in pre-feature configs → stays false.
  if (typeof data.uiHidden === 'boolean') {
    uiHidden = data.uiHidden;
  }
  applyUiHiddenState();

  if (render) scheduleRender();
}
```

Note: no `SCENE_CONFIG_VERSION` bump. `uiHidden` is a backward-compatible optional field guarded by the `typeof` check; older configs simply lack it and default to `false`. Bumping the version would instead discard all previously-saved scene state.

- [ ] **Step 3: Verify persistence**

Reload `scene.html` (hard reload). Click **Hide UI** on. Reload the page normally.
Expected: after reload, Hide UI is still active (button outlined, overlays hidden, switches greyed). Toggle it off, reload again → it stays off. Open the browser devtools Application → Local Storage → the `manosaba.scene.config` entry and confirm a `"uiHidden": true/false` field is present.

- [ ] **Step 4: Commit**

```bash
git add scene.js
git commit -m "Persist Hide UI state in the scene config"
```

---

## Task 5: Reset clears the flag

**Files:**
- Modify: `scene.js` the `resetBtn` click handler

- [ ] **Step 1: Reset `uiHidden` in the reset handler**

The reset handler branches on `sceneType`. `uiHidden` is scene-type-independent, so clear it once before the branch.

In `scene.js`, replace:

```javascript
  document.getElementById('resetBtn').onclick = async () => {
    if (!await showModal('Reset all customizations to default?')) return;
    if (sceneType === 'trial') {
```

with:

```javascript
  document.getElementById('resetBtn').onclick = async () => {
    if (!await showModal('Reset all customizations to default?')) return;
    // "Hide UI" is a view mode, not scene content — reset it for both types.
    uiHidden = false;
    applyUiHiddenState();
    if (sceneType === 'trial') {
```

- [ ] **Step 2: Verify**

Reload `scene.html` (hard reload). Click **Hide UI** on, then click **Reset** and confirm the modal.
Expected: Hide UI turns off (button neutral, overlays visible again, switches un-greyed) along with the other reset defaults.

- [ ] **Step 3: Commit**

```bash
git add scene.js
git commit -m "Clear Hide UI state on reset"
```

---

## Task 6: Bump the build version and run the test suites

**Files:**
- Modify: `scene.js:3` (`BUILD_VERSION`), `scene.html` (both `?v=` query strings)

- [ ] **Step 1: Bump `BUILD_VERSION` in `scene.js`**

In `scene.js`, replace:

```javascript
const BUILD_VERSION = '20260717a';
```

with:

```javascript
const BUILD_VERSION = '20260718a';
```

- [ ] **Step 2: Bump the stylesheet query string in `scene.html`**

In `scene.html`, replace:

```html
<link rel="stylesheet" href="styles.css?v=20260717a">
```

with:

```html
<link rel="stylesheet" href="styles.css?v=20260718a">
```

- [ ] **Step 3: Bump the script query string in `scene.html`**

In `scene.html`, replace:

```html
<script type="module" src="scene.js?v=20260717a"></script>
```

with:

```html
<script type="module" src="scene.js?v=20260718a"></script>
```

- [ ] **Step 4: Run the existing test suites (must pass unchanged)**

Run: `python3 -m pytest tests/ -q`
Expected: PASS (this feature touches no Python; the suite should be green exactly as before).

Run: `node --test tests/bg_picker.test.mjs`
Expected: PASS (the background-picker model tests are unrelated and must stay green).

- [ ] **Step 5: Final full manual verification**

Serve (`python3 -m http.server 8080`) and open `scene.html` in a normal reload (the `?v=` bump means no hard-reload is needed now). Walk the full checklist once more:
- Adv, Trial-Adv, Trial-Debate: Hide UI removes all in-scene UI, leaving background/courtroom + characters.
- Overlay switches grey out and are non-interactive while hidden; other controls (Message input, Trial Choice UI) remain interactive.
- Toggling back restores every overlay to its prior per-switch state (non-destructive).
- Export PNG while hidden yields a clean background+character image.
- Reload preserves the hidden state; Reset clears it.

- [ ] **Step 6: Commit**

```bash
git add scene.js scene.html
git commit -m "Bump scene editor build version for Hide UI feature"
```

---

## Self-review notes

- **Spec coverage:** state flag (Task 2); persistence without a version bump (Task 4); render gating for adv + trial (Task 3); export honors it with no extra code (Task 3 Step 4); button in actions row with active state (Tasks 1–2); greying the three Overlays fields via `data-overlay-toggles` + `.panel.ui-hidden` (Tasks 1–2); reset clears it (Task 5). The spec's "three render sites" is implemented as two gates — the trial early-return covers both trial subtypes at once, which is equivalent and simpler.
- **Type/name consistency:** `uiHidden`, `applyUiHiddenState`, `hideUiBtn`, `hide-ui-btn`, `data-overlay-toggles`, and `.panel.ui-hidden` are used identically across HTML, CSS, and JS tasks.
- **No placeholders:** every step shows the exact edit.
