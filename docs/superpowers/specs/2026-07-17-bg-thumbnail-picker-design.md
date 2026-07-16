# Background thumbnail picker (Adv scene editor)

**Date:** 2026-07-17
**Status:** Approved, ready for implementation planning

## Problem

The Adv-mode background field (`scene.html:45`) is a native `<select>` whose options are named
`Background_001_001`, `Still_023_004`, and so on. The numbers carry no meaning, so choosing a
background means selecting one, waiting for a full render, and repeating until something looks
right. There are 58 main backgrounds and 172 stills.

## Constraints

- Source art is **4096×2048 PNG, 5–10 MB per file, ~1.25 GB total** across 230 numbered entries.
  Previewing the real images on hover is not viable — one hover would pull 10 MB.
- `*.png` is gitignored and **no image is tracked in git**. Art is a local-only artifact produced
  by the extractor pipeline.
- The stage crops backgrounds: `renderBackground` (`scene.js:1075-1088`) cover-fits with
  `Math.max(CANVAS_W/iw, CANVAS_H/ih)` and center-crops to 2560×1440. Source art is 2:1 but the
  stage is 16:9, so roughly 10% of image height is never visible.
- Browsers do not fire hover events on native `<option>` elements, and cannot render images inside
  them. Any thumbnail affordance requires replacing the `<select>` with a custom widget.
- The scene editor has a mobile drawer (`scene.html:15`, `styles.css:1172`), so touch — where hover
  does not exist — is a real surface.

## Decisions

Reached during brainstorming, with the alternatives that were rejected:

| Decision | Chosen | Rejected |
|---|---|---|
| Picker form | Dropdown list with hover preview | Thumbnail grid popover; always-open thumbnail list in panel |
| Preview surface | Row-anchored floating popover | Fixed slot under the field; live stage swap |
| Touch behavior | Tap to preview, second tap on same row commits | Inline thumbnails per row; native `<select>` fallback |
| Thumbnail artifact | Gitignored build output | Committed WebP (~2 MB) |

## Design

### 1. Thumbnail pipeline — `scripts/build_bg_thumbs.py` (new)

```bash
python3 scripts/build_bg_thumbs.py [<root>]   # default root: ./scene/backgrounds
```

Reads `scene/backgrounds/meta.json` — already the picker's source of truth — and processes its
`main` and `stills` lists. The `utility` list is skipped, matching the picker, which omits those
author/debug helpers (`scene.js:3221-3222`).

Output: `scene/backgrounds/thumbs/{main,stills}/{name}.webp`

- **480×270 WebP, quality 80.** Measured on real files: 10–30 KB each, ~3.5 MB for all 230.
  WebP beats JPEG by ~20% at matched quality on this large flat-shaded art.
- Produced with the **same cover-fit + center-crop math as `renderBackground`**, so a thumbnail
  cannot promise framing the stage will not deliver. This is the one invariant the script must
  hold; if `renderBackground` ever changes its fit, this script changes with it.
- **Incremental**: skip when the thumb's mtime is newer than its source's.
- **Prunes** thumbs whose source no longer exists.
- Full cold run is roughly a minute; decoding 4096×2048 PNGs dominates, not the resize.

`.gitignore` gains `scene/backgrounds/thumbs/`.

**No change to `meta.json`.** The thumb URL is derived as `thumbs/{dir}/{name}.webp`, keeping
`build_backgrounds_meta.py` untouched and the two scripts independent. Recording a `thumb: true`
flag instead would force a run-order dependency and would lie whenever a thumb is deleted; a 404
with a graceful fallback is more honest.

### 2. The picker — `bg_picker.js` (new module)

A self-contained widget in its own file. `scene.js` is already 213 KB / ~4,500 lines; a widget with
a narrow interface should not be buried in it. `scene.html:518` already loads `scene.js` as
`type="module"` and `scene.js` currently imports nothing, so this is the first import.

```js
export function createBgPicker({ mount, thumbUrl, onChange }) → {
  setGroups(groups),  // [{ label: 'Main', items: [{ value, label }] }, …]
  setValue(path),
  getValue(),
}
```

- `mount` — element to render into.
- `thumbUrl(value)` — maps a background path to its thumbnail URL. Injected so the widget owns no
  knowledge of the asset layout. Returning `null` means "this row has nothing to preview", and the
  widget shows no popover for it.
- `onChange(value)` — fires only on commit, never on preview. `''` means "(none — black)".

The `(none — black)` entry is passed in by the caller like any other row — an item with
`value: ''` in the first group — so the widget has no special case for it. `thumbUrl('')` returns
`null`, so hovering it shows no popover.

**Structure.** Closed, a button styled like `.char-select` showing the current label. Open, a filter
input above a scrollable list (capped ~360px) of group headers and rows.

**Behavior by input:**

- **Desktop (`pointer: fine`)** — hovering a row floats the popover beside it after an **80 ms
  delay**, flipping to the opposite side near the viewport edge. Single click commits.
- **Touch (`pointer: coarse`)** — first tap on a row floats the popover; a second tap on that same
  row commits. Tapping a different row moves the preview rather than committing.
- **Keyboard** — ↑/↓ move the active row and preview it as they go; Enter commits; Esc closes.
  Typing goes to the filter box.

The 80 ms delay is load-bearing, not cosmetic: without it, dragging the cursor down 60 rows fires
60 fetches; with it, only the row the cursor rests on loads.

**Filter box.** Case-insensitive substring match against the row label, applied across all groups
at once; a group header disappears when none of its rows match. With 172 stills, typing `023`
narrows to a handful of rows and removes the main weakness of a hunt-based list. The
`(none — black)` row is exempt from filtering and always stays visible.

**Accessibility.** `role="listbox"` on the list, `role="option"` on rows, `aria-activedescendant`
tracking the active row.

### 3. Wiring into `scene.js`

`scene.html:45` swaps `<select class="char-select" id="bgSelect">` for `<div id="bgPicker">`.

Four call sites move to the new interface:

| Site | Today | After |
|---|---|---|
| `scene.js:3198` `populateBgSelect` | builds `<optgroup>`/`<option>` | builds groups, calls `setGroups` + `setValue` |
| `scene.js:4222` | `bgSelect.onchange` | `onChange` callback |
| `scene.js:718` (state restore) | `bgSelect.value = bgPath \|\| ''` | `bgPicker.setValue(bgPath \|\| '')` |
| `scene.js:4510` (reset) | `bgSelect.value = bgPath \|\| ''` | `bgPicker.setValue(bgPath \|\| '')` |

`bgPath` (`scene.js:59`) stays the single source of truth and persists exactly as it does today
(`scene.js:473`). **The snapshot/state format does not change.** The `(none — black)` entry survives
as a normal row.

### 4. Edge cases

- **Missing thumbnail** (fresh clone, or new backgrounds extracted without rerunning the script):
  the image 404s and the popover shows a placeholder reading *"no thumbnail — run
  scripts/build_bg_thumbs.py"*. Never a silent blank.
- **Repeat hovers**: loaded thumbs are cached in a `Map<value, HTMLImageElement>`.
- **Empty filter result**: the list shows a "no matches" row.

### 5. Styling

New rules in `styles.css` using the existing palette — `--bg-card` for the closed button and rows,
`--active` (`#a78bfa`) for the hovered/active row and the popover border, `--bg-deep` for the
popover backing, `--text-muted` for group headers and the filename caption.

## Out of scope

- The Author and other `<select>` elements keep their native form. The widget is built for the
  background field; generalizing it is a later decision, driven by a second real use.
- The `utility` backgrounds (`Grid_001`, `Grid_002`, `SolidColor`, `Transparent`) stay out of the
  picker, as today.
- Full-resolution art loading is unchanged. Committing to a background still loads the real PNG
  through the existing `renderBackground` path.

## Verification

- Run `build_bg_thumbs.py` and confirm the file count matches `meta.json`'s `main` + `stills`
  totals, that a thumb's aspect is 16:9, and that a rerun is a no-op.
- Drive the editor and confirm: hover shows the right art; click commits and the stage renders the
  same background the popover showed; reload restores the selection; Reset returns to the first
  main background; keyboard navigation previews and commits; a deleted thumb yields the placeholder
  rather than a blank popover.
