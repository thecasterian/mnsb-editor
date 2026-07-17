# Hide UI button — design spec

**Date:** 2026-07-18
**Component:** Scene editor (`scene.html` + `scene.js` + `styles.css`)

## Goal

Add a **Hide UI** button to the scene editor that renders a "clean stage" —
background and characters only, with every piece of in-scene game UI suppressed.
The primary use is exporting a wallpaper-style PNG of just the background and
placed characters.

## What "UI" means

"UI" is the in-scene game UI composited onto the preview canvas:

- **Adv / trial-adv:** the NormalPrinter dialog frame, the author plate +
  AuthorLabel text, the MessageLabel text, and the AutoToggle / ControlPanel
  (menu) / WitchBookButtonUI overlays.
- **Trial-debate:** the tilted testimony text, the trial-choice screen, the
  WitchBookButtonUI overlay, and the DebateUI HUD (clock plate, countdown timer,
  fast-skip button).

"UI" does **not** mean the editor's own left-panel controls — those always stay.
Background and character placements/billboards always remain rendered.

This intentionally includes elements that have **no** individual toggle today:
the Adv dialog frame itself (the scene's anchor) and the message/testimony text.

## Approach

A single non-destructive master flag gating the render, chosen over the two
alternatives:

- **Rejected — flip all individual toggle checkboxes off.** Destructive (loses
  the user's per-overlay state) and still doesn't cover the un-toggleable dialog
  frame and text.
- **Rejected — CSS-hide overlay DOM.** Overlays are composited into the canvas
  pixel buffer, not DOM elements, so CSS can't touch them and export wouldn't
  reflect the change.
- **Chosen — one boolean gating the overlay-composite loops.** Non-destructive
  (individual toggle state is untouched and returns exactly as it was), covers
  the un-toggleable dialog frame + text, and makes export WYSIWYG automatically
  because export reuses the render functions.

## Design

### State & persistence

- Add a module-level `let uiHidden = false;` in `scene.js`.
- Persist it: add `uiHidden` to the `saveSceneConfig()` payload, and restore it
  in `loadSceneConfig()` behind a `typeof data.uiHidden === 'boolean'` guard.
- **No `SCENE_CONFIG_VERSION` bump.** It's a backward-compatible optional field;
  older saved configs simply lack it and default to `false` (UI shown). Bumping
  the version would instead discard all previously-saved state, which we don't
  want.

### Render gating

`uiHidden` short-circuits the overlay-composite work at all three sites, leaving
the background + placements/billboards already drawn:

1. `renderScene()` (adv) — skip the `sceneMeta.prefabs` loop.
2. `renderTrialScene()` trial-adv branch — skip that prefab loop.
3. `renderTrialScene()` trial-debate branch — skip `renderDebateText`,
   `renderTrialChoiceUI`, the WitchBook prefab loop, and the DebateUI HUD block.

In each case the guard is an early `if (uiHidden) { /* skip overlays */ }` around
the existing overlay code; background and character rendering run before the
guard and are unaffected.

### Export

No dedicated export code. `exportPng()` calls the same
`renderScene`/`renderTrialScene`, so with `uiHidden` on the exported PNG is a
clean background+character render — WYSIWYG with the preview.

### Button

- A `Hide UI` toggle button added to the `.actions` row in `scene.html`
  (alongside Reset / Export PNG), with an `id` such as `hideUiBtn`.
- Gains an `active` class while engaged (same visual affordance as other active
  toggle buttons in the editor).
- On click: flip `uiHidden`, call the shared `applyUiHiddenState()` helper
  (updates the button's `active` class and the panel greying — see below),
  `scheduleRender()`, and `scheduleSceneConfigSave()`.
- On load, `loadSceneConfig()` restores `uiHidden` and calls
  `applyUiHiddenState()` so the button and greying reflect the saved state.

### Greying the overlay switches

While `uiHidden` is on, the individual overlay switches are dimmed and
non-interactive to signal they have no effect:

- Mark the three **Overlays** `.field` blocks in `scene.html` (adv, trial-adv,
  and trial-debate) with a `data-overlay-toggles` attribute.
- `applyUiHiddenState()` toggles a single `ui-hidden` class on the `.panel`
  element.
- A CSS rule dims and disables them in one shot:

  ```css
  .panel.ui-hidden [data-overlay-toggles] {
    opacity: 0.4;
    pointer-events: none;
  }
  ```

**Scope note:** this greys the Overlays switch groups only — Author / Auto-toggle
/ Menu / Witch Book and their trial/debate counterparts (Clock, Fast button,
etc.). The Message / Testimony text inputs and the Trial-Choice-UI field stay
interactive; they simply render nothing while UI is hidden.

## Testing

- **Manual (primary):** serve with `python3 -m http.server 8080`, open the scene
  editor. Verify for each scene type (adv, trial-adv, trial-debate):
  - Toggling **Hide UI** removes all in-scene UI, leaving background + characters.
  - The overlay switches grey out and are non-interactive while hidden.
  - Toggling back restores every overlay to its prior per-switch state
    (non-destructive).
  - **Export PNG** while hidden produces a clean background+character image.
  - Reloading the page preserves the hidden state (persistence).
- No new automated test harness is added; this is view/render wiring with no
  pure-logic surface comparable to `bg_picker.js`. The existing
  `python3 -m pytest tests/ -q` and `node --test` suites must still pass
  unchanged.

## Out of scope

- Greying or disabling the Message/Testimony text inputs and Trial-Choice-UI
  controls.
- Any change to what counts as "background" or "characters" per scene type.
- Persisting the state anywhere other than the existing `manosaba.scene.config`
  localStorage record.
