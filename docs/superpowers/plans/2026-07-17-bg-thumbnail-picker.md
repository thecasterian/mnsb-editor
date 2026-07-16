# Background Thumbnail Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Adv scene editor's numeric background `<select>` with a custom dropdown that floats a thumbnail preview beside the hovered row.

**Architecture:** A new Python script bakes 480×270 WebP thumbnails from the 4096×2048 source PNGs, using the same cover-fit + center-crop math the stage uses. A new zero-dependency ES module, `bg_picker.js`, renders the dropdown and popover; its pure logic (filtering, keyboard navigation, touch tap resolution) is exported separately so it can be tested without a DOM. `scene.js` keeps `bgPath` as its single source of truth and swaps four call sites to the new interface.

**Tech Stack:** Python 3 + Pillow (thumbnails), pytest 9 (Python tests), vanilla ES modules (widget), Node 20's built-in `node --test` (JS logic tests), plain HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-07-17-bg-thumbnail-picker-design.md`

---

## Context you need before starting

**The repo has no build step and no JS dependencies.** It is a static site served with `python3 -m http.server 8080`. Do not add npm packages. The one `package.json` this plan adds exists solely to mark `.js` files as ES modules so Node's built-in test runner can import them; it has no dependencies.

**Module imports use a cache-busting dynamic import.** `scene.js:11-12` shows the established pattern:

```js
const { snapshotGetAll, snapshotDelete, snapshotChannel } =
  await import(`./snapshot_store.js?v=${BUILD_VERSION}`);
```

A plain `import { x } from './y.js'` would not be cache-busted. Follow the existing pattern.

**The stage crops backgrounds.** `scene.js:1075-1088`:

```js
async function renderBackground(filePath, dst) {
  const img = await loadSpriteImage(filePath);
  const iw = img.width, ih = img.height;
  const s = Math.max(CANVAS_W / iw, CANVAS_H / ih);   // cover-fit
  ...
  const left = Math.floor((nw - CANVAS_W) / 2);        // center-crop
  const top  = Math.floor((nh - CANVAS_H) / 2);
  dst.set(imageDataToLinear(ctx.getImageData(left, top, CANVAS_W, CANVAS_H)));
}
```

Source art is 4096×2048 (2:1); the stage is 2560×1440 (16:9). About 10% of image height is never visible. The thumbnail script must reproduce this crop or thumbnails will promise framing the stage does not deliver.

**Source art may be absent.** `*.png` is gitignored and no image is tracked in git. A clone without the extracted bundles has no backgrounds. Every task below must work on such a clone except Task 3 and Task 11, which explicitly need real art.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/build_bg_thumbs.py` | Create | Bake `scene/backgrounds/thumbs/{main,stills}/*.webp` from source PNGs |
| `tests/conftest.py` | Create | Put `scripts/` on `sys.path` for pytest |
| `tests/test_build_bg_thumbs.py` | Create | Tests for crop math, incremental rebuild, pruning |
| `package.json` | Create | `{"type": "module"}` only — lets `node --test` import `.js` as ESM |
| `bg_picker.js` | Create | The dropdown widget + its exported pure logic |
| `tests/bg_picker.test.mjs` | Create | Tests for `filterGroups`, `nextActiveValue`, `tapAction` |
| `bg_picker_test.html` | Create | Standalone manual page for hover/popover/touch, mirroring `scene_court_test.html` |
| `styles.css` | Modify | Picker + popover rules, appended at end |
| `scene.html:45` | Modify | `<select id="bgSelect">` → `<div id="bgPicker">` |
| `scene.js` | Modify | Import picker; `bgThumbUrl`; `populateBgPicker`; 3 call sites |
| `.gitignore` | Modify | Ignore `scene/backgrounds/thumbs/` |
| `CLAUDE.md` | Modify | Document the new script + `thumbs/` output |

---

## Task 1: Crop math

**Files:**
- Create: `scripts/build_bg_thumbs.py`
- Create: `tests/conftest.py`
- Create: `tests/test_build_bg_thumbs.py`

- [ ] **Step 1: Write `tests/conftest.py`**

The repo is not a Python package and `scripts/` has no `__init__.py`, so pytest cannot import the script by name. This puts `scripts/` on the path:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
```

- [ ] **Step 2: Write the failing test**

`tests/test_build_bg_thumbs.py`:

```python
from build_bg_thumbs import cover_crop_box


def test_crop_box_of_2to1_source_takes_full_width_and_trims_height():
    # 4096x2048 is the real background shape. 16:9 of 2048px height is
    # 3641px wide, so 227px comes off each side.
    assert cover_crop_box(4096, 2048) == (227, 0, 3868, 2048)


def test_crop_box_of_exact_16by9_source_is_the_whole_image():
    assert cover_crop_box(2560, 1440) == (0, 0, 2560, 1440)


def test_crop_box_of_tall_source_trims_top_and_bottom():
    # 16:9 of 1000px width is exactly 562.5px tall, and Python's round() is
    # banker's rounding — round(562.5) is 562, not 563. So 438px gets split,
    # 219 off each end. Don't "correct" this to 218/563.
    assert cover_crop_box(1000, 1000) == (0, 219, 1000, 781)


def test_crop_box_is_always_16by9_within_a_pixel():
    for iw, ih in [(4096, 2048), (2560, 1440), (1000, 1000), (1920, 1200), (800, 3000)]:
        left, top, right, bottom = cover_crop_box(iw, ih)
        w, h = right - left, bottom - top
        assert abs(w / h - 2560 / 1440) < 0.01
        assert left >= 0 and top >= 0 and right <= iw and bottom <= ih
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest tests/test_build_bg_thumbs.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'build_bg_thumbs'`

- [ ] **Step 4: Write the minimal implementation**

`scripts/build_bg_thumbs.py`:

```python
#!/usr/bin/env python3
"""Bake background/still thumbnails for the scene editor's background picker.

The source art is 4096x2048 and 5-10 MB per file, far too heavy to preview on
hover, so the picker previews these instead.

The crop mirrors scene.js:renderBackground, which cover-fits the art with
max(CANVAS_W/iw, CANVAS_H/ih) and center-crops to 2560x1440. Source art is 2:1
but the stage is 16:9, so ~10% of image height never reaches the screen. A
thumbnail cropped any other way would promise framing the stage won't deliver;
that correspondence is this script's one invariant. If renderBackground ever
changes its fit, change STAGE_ASPECT / cover_crop_box with it.
"""

STAGE_ASPECT = 2560 / 1440


def cover_crop_box(iw, ih, aspect=STAGE_ASPECT):
    """Largest centered `aspect`-ratio box inside an iw x ih image.

    Returns a PIL crop box: (left, top, right, bottom).
    """
    if iw / ih > aspect:
        nw, nh = round(ih * aspect), ih      # too wide: trim the sides
    else:
        nw, nh = iw, round(iw / aspect)      # too tall: trim top and bottom
    left = (iw - nw) // 2
    top = (ih - nh) // 2
    return (left, top, left + nw, top + nh)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_build_bg_thumbs.py -v`
Expected: PASS — 4 passed

- [ ] **Step 6: Commit**

```bash
git add scripts/build_bg_thumbs.py tests/conftest.py tests/test_build_bg_thumbs.py
git commit -m "Add stage-matching crop math for background thumbnails"
```

---

## Task 2: Thumbnail baking, incremental rebuild, pruning

**Files:**
- Modify: `scripts/build_bg_thumbs.py`
- Modify: `tests/test_build_bg_thumbs.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_build_bg_thumbs.py`, and replace its single import line with this block:

```python
import json
import os

from PIL import Image

from build_bg_thumbs import THUMB_H, THUMB_W, build, cover_crop_box


def _fixture_root(tmp_path, main=("Background_001_001",), stills=("Still_001_001",)):
    """A miniature scene/backgrounds tree: real PNGs, 2:1 like the real art."""
    root = tmp_path / "backgrounds"
    for d, names in (("main", main), ("stills", stills)):
        (root / d).mkdir(parents=True)
        for n in names:
            Image.new("RGB", (400, 200), (10, 20, 30)).save(root / d / f"{n}.png")
    meta = {
        "main": [{"id": "001_001", "name": n, "file": f"{n}.png", "size": [400, 200]} for n in main],
        "stills": [{"id": "001_001", "name": n, "file": f"{n}.png", "size": [400, 200]} for n in stills],
        "utility": [{"name": "Grid_001", "file": "Grid_001.png", "size": [400, 200], "from": "main"}],
    }
    (root / "meta.json").write_text(json.dumps(meta))
    return root


def test_build_writes_one_webp_per_main_and_stills_entry(tmp_path):
    root = _fixture_root(tmp_path)
    stats = build(root)
    assert (root / "thumbs" / "main" / "Background_001_001.webp").exists()
    assert (root / "thumbs" / "stills" / "Still_001_001.webp").exists()
    assert stats["written"] == 2


def test_build_skips_utility_entries(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    # Grid_001 is in meta.json's utility list; the picker omits those, so we do too.
    assert not (root / "thumbs" / "main" / "Grid_001.webp").exists()


def test_thumb_has_the_declared_size_and_stage_framing(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    with Image.open(root / "thumbs" / "main" / "Background_001_001.webp") as im:
        assert im.size == (THUMB_W, THUMB_H)
        assert im.format == "WEBP"


def test_rerun_is_a_noop_when_nothing_changed(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    stats = build(root)
    assert stats["written"] == 0
    assert stats["skipped"] == 2


def test_rerun_rebuilds_a_thumb_whose_source_is_newer(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    src = root / "main" / "Background_001_001.png"
    thumb = root / "thumbs" / "main" / "Background_001_001.webp"
    future = thumb.stat().st_mtime + 10
    os.utime(src, (future, future))
    stats = build(root)
    assert stats["written"] == 1
    assert stats["skipped"] == 1


def test_build_prunes_thumbs_whose_source_is_gone(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    orphan = root / "thumbs" / "main" / "Background_999_999.webp"
    orphan.write_bytes(b"stale")
    stats = build(root)
    assert not orphan.exists()
    assert stats["pruned"] == 1


def test_build_reports_missing_sources_without_crashing(tmp_path):
    root = _fixture_root(tmp_path)
    (root / "main" / "Background_001_001.png").unlink()
    stats = build(root)
    assert stats["missing"] == 1
    assert stats["written"] == 1        # the still still builds
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_build_bg_thumbs.py -v`
Expected: FAIL — `ImportError: cannot import name 'build' from 'build_bg_thumbs'`

- [ ] **Step 3: Write the implementation**

Add to `scripts/build_bg_thumbs.py`, after the `cover_crop_box` function. Add `import json` and `from pathlib import Path` and `from PIL import Image` at the top:

```python
THUMB_W = 480
THUMB_H = 270
QUALITY = 80

# meta.json's `utility` list (Grid_001, SolidColor, Transparent, ...) is skipped
# on purpose: the picker omits those author/debug helpers too, so a thumbnail
# for them would never be shown.
DIRS = ("main", "stills")


def make_thumb(src, dst):
    """Write one stage-framed WebP thumbnail of `src` to `dst`."""
    with Image.open(src) as im:
        im = im.convert("RGB")
        im = im.crop(cover_crop_box(*im.size))
        im = im.resize((THUMB_W, THUMB_H), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, "WEBP", quality=QUALITY)


def build(root):
    """Bake every main/stills thumbnail under `root`. Returns a stats dict.

    Incremental: a thumbnail at least as new as its source is left alone, so a
    rerun after extracting one new background costs one decode, not 230.
    """
    root = Path(root)
    meta = json.loads((root / "meta.json").read_text())
    thumbs_root = root / "thumbs"
    stats = {"written": 0, "skipped": 0, "pruned": 0, "missing": 0}
    wanted = set()

    for d in DIRS:
        for entry in meta.get(d, []):
            src = root / d / entry["file"]
            dst = thumbs_root / d / (Path(entry["file"]).stem + ".webp")
            wanted.add(dst)
            if not src.exists():
                stats["missing"] += 1
                continue
            if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
                stats["skipped"] += 1
                continue
            make_thumb(src, dst)
            stats["written"] += 1

    for d in DIRS:
        d_path = thumbs_root / d
        if not d_path.is_dir():
            continue
        for f in d_path.glob("*.webp"):
            if f not in wanted:
                f.unlink()
                stats["pruned"] += 1

    return stats
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_build_bg_thumbs.py -v`
Expected: PASS — 11 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/build_bg_thumbs.py tests/test_build_bg_thumbs.py
git commit -m "Bake background thumbnails incrementally with pruning"
```

---

## Task 3: CLI entry point and a real run

**Files:**
- Modify: `scripts/build_bg_thumbs.py`
- Modify: `.gitignore`

This is the one task that needs the real extracted art. If `scene/backgrounds/main/` is empty on your machine, do Steps 1–3 and 6, and leave Steps 4–5 to someone with the bundles extracted.

- [ ] **Step 1: Add the CLI**

Append to `scripts/build_bg_thumbs.py` (add `import sys` at the top):

```python
def main(argv):
    root = Path(argv[1]) if len(argv) > 1 else Path("scene/backgrounds")
    if not (root / "meta.json").exists():
        print(f"error: no meta.json under {root} — run build_backgrounds_meta.py first",
              file=sys.stderr)
        return 1
    stats = build(root)
    print(f"thumbs: {stats['written']} written, {stats['skipped']} up-to-date, "
          f"{stats['pruned']} pruned, {stats['missing']} sources missing")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 2: Ignore the output**

Append to `.gitignore`:

```
scene/backgrounds/thumbs/
```

- [ ] **Step 3: Verify the error path**

Run: `python3 scripts/build_bg_thumbs.py /tmp/definitely-not-a-bg-root; echo "exit=$?"`
Expected: `error: no meta.json under /tmp/definitely-not-a-bg-root — run build_backgrounds_meta.py first` and `exit=1`

- [ ] **Step 4: Run it for real** (needs extracted art)

Run: `python3 scripts/build_bg_thumbs.py`
Expected: roughly a minute, then `thumbs: 230 written, 0 up-to-date, 0 pruned, 0 sources missing`

- [ ] **Step 5: Verify the output matches meta.json** (needs extracted art)

Run:

```bash
python3 - <<'PY'
import json, subprocess
from pathlib import Path
meta = json.loads(Path('scene/backgrounds/meta.json').read_text())
for d in ('main', 'stills'):
    want = len(meta[d])
    have = len(list(Path(f'scene/backgrounds/thumbs/{d}').glob('*.webp')))
    print(f'{d}: meta={want} thumbs={have} {"OK" if want == have else "MISMATCH"}')
size = sum(f.stat().st_size for f in Path('scene/backgrounds/thumbs').rglob('*.webp'))
print(f'total: {size/1024/1024:.1f} MB')
PY
git status --short          # must show nothing under scene/backgrounds/thumbs/
```

Expected: `main: meta=58 thumbs=58 OK`, `stills: meta=172 thumbs=172 OK`, total around 3–4 MB, and a clean `git status`.

- [ ] **Step 6: Commit**

```bash
git add scripts/build_bg_thumbs.py .gitignore
git commit -m "Add build_bg_thumbs CLI and ignore its output"
```

---

## Task 4: Picker model — filtering and keyboard navigation

**Files:**
- Create: `package.json`
- Create: `bg_picker.js`
- Create: `tests/bg_picker.test.mjs`

The widget's group shape, used throughout:

```js
[
  { label: null,     items: [{ value: '', label: '(none — black)', pinned: true }] },
  { label: 'Main',   items: [{ value: 'scene/backgrounds/main/Background_001_001.png',
                               label: 'Background_001_001' }, …] },
  { label: 'Stills', items: [{ value: 'scene/backgrounds/stills/Still_001_001.png',
                               label: 'Still_001_001' }, …] },
]
```

A `label: null` group renders no header. `pinned: true` marks a row the filter never hides — `(none — black)` must always be reachable.

- [ ] **Step 1: Create `package.json`**

Node treats `.js` as CommonJS unless told otherwise, which would make `node --test` choke on `export`. This file exists only to fix that. **It declares no dependencies and must stay that way.**

```json
{
  "name": "manosaba-editor",
  "version": "0.0.0",
  "private": true,
  "description": "Static character/scene editor. No build step, no dependencies. `type: module` exists so Node's built-in test runner can import the browser modules as ESM.",
  "type": "module"
}
```

- [ ] **Step 2: Write the failing tests**

`tests/bg_picker.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterGroups, nextActiveValue, visibleValues } from '../bg_picker.js';

const GROUPS = [
  { label: null, items: [{ value: '', label: '(none — black)', pinned: true }] },
  { label: 'Main', items: [
    { value: 'm/Background_001_001.png', label: 'Background_001_001' },
    { value: 'm/Background_023_001.png', label: 'Background_023_001' },
  ] },
  { label: 'Stills', items: [
    { value: 's/Still_023_004.png', label: 'Still_023_004' },
  ] },
];

test('an empty filter returns every group unchanged', () => {
  assert.deepEqual(filterGroups(GROUPS, ''), GROUPS);
});

test('a filter keeps matching rows across every group', () => {
  const out = filterGroups(GROUPS, '023');
  assert.deepEqual(out.map(g => g.label), [null, 'Main', 'Stills']);
  assert.deepEqual(out[1].items.map(i => i.label), ['Background_023_001']);
  assert.deepEqual(out[2].items.map(i => i.label), ['Still_023_004']);
});

test('a group with no matching rows disappears', () => {
  const out = filterGroups(GROUPS, 'Still');
  assert.deepEqual(out.map(g => g.label), [null, 'Stills']);
});

test('filtering is case-insensitive', () => {
  assert.equal(filterGroups(GROUPS, 'background_023').length, 2);
});

test('the pinned row survives a filter that matches nothing', () => {
  const out = filterGroups(GROUPS, 'zzzz');
  assert.deepEqual(out.map(g => g.label), [null]);
  assert.deepEqual(out[0].items.map(i => i.value), ['']);
});

test('visibleValues flattens groups into display order', () => {
  assert.deepEqual(visibleValues(GROUPS), [
    '', 'm/Background_001_001.png', 'm/Background_023_001.png', 's/Still_023_004.png',
  ]);
});

test('arrowing down from nothing lands on the first row', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], null, 1), 'a');
});

test('arrowing up from nothing lands on the last row', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], null, -1), 'c');
});

test('arrowing moves one row at a time', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'b', -1), 'a');
});

test('arrowing clamps at both ends rather than wrapping', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'c', 1), 'c');
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'a', -1), 'a');
});

test('arrowing after the active row was filtered away starts over', () => {
  assert.equal(nextActiveValue(['a', 'b'], 'gone', 1), 'a');
  assert.equal(nextActiveValue(['a', 'b'], 'gone', -1), 'b');
});

test('arrowing an empty list yields nothing', () => {
  assert.equal(nextActiveValue([], null, 1), null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/bg_picker.test.mjs`
Expected: FAIL — `Cannot find module .../bg_picker.js`

- [ ] **Step 4: Write the implementation**

`bg_picker.js` — the pure half. **Nothing at module scope may touch `document` or `window`**, or these tests stop working:

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/bg_picker.test.mjs`
Expected: PASS — `# pass 12`

- [ ] **Step 6: Commit**

```bash
git add package.json bg_picker.js tests/bg_picker.test.mjs
git commit -m "Add background picker filtering and keyboard navigation model"
```

---

## Task 5: Touch tap resolution

**Files:**
- Modify: `bg_picker.js`
- Modify: `tests/bg_picker.test.mjs`

> **This task asks the implementing human for the implementation.** The tests and the prepared location are given; the ~6 lines of logic in Step 3 are a design decision, not boilerplate. See the note at the end of this task.

Touch has no hover, so the chosen behavior is: **first tap previews, a second tap on the same row commits.** The wrinkle is `(none — black)`, which has no thumbnail — making a user tap twice to reach a row that can never show a preview would be a two-tap tax for nothing.

- [ ] **Step 1: Write the failing tests**

Append to `tests/bg_picker.test.mjs`, and add `tapAction` to the import at the top of the file:

```js
test('the first tap on a row previews it', () => {
  assert.equal(tapAction({ previewValue: null }, { value: 'a', hasThumb: true }), 'preview');
});

test('a second tap on the previewing row commits it', () => {
  assert.equal(tapAction({ previewValue: 'a' }, { value: 'a', hasThumb: true }), 'commit');
});

test('tapping a different row moves the preview instead of committing', () => {
  assert.equal(tapAction({ previewValue: 'a' }, { value: 'b', hasThumb: true }), 'preview');
});

test('a row with no thumbnail commits on the first tap', () => {
  // "(none — black)" has nothing to preview; two taps would be a tax for nothing.
  assert.equal(tapAction({ previewValue: null }, { value: '', hasThumb: false }), 'commit');
  assert.equal(tapAction({ previewValue: 'a' }, { value: '', hasThumb: false }), 'commit');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bg_picker.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../bg_picker.js' does not provide an export named 'tapAction'`

- [ ] **Step 3: Implement `tapAction`**

Add to `bg_picker.js`, below `nextActiveValue`. The signature, doc comment, and constraints are prepared; the body is yours:

```js
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
  // TODO: implement — see the four tests in tests/bg_picker.test.mjs
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bg_picker.test.mjs`
Expected: PASS — `# pass 16`

- [ ] **Step 5: Commit**

```bash
git add bg_picker.js tests/bg_picker.test.mjs
git commit -m "Resolve touch taps to preview or commit"
```

**Why this one is worth writing yourself:** it is the whole touch interaction in six lines, and the interesting part is not the two-tap rule — it is the ordering. Check `hasThumb` before the same-row comparison and `(none — black)` commits on one tap; check it after and it does too, but only by accident, because `previewValue` can never equal a row that never previewed. One of those is a rule; the other is a coincidence that a future edit will quietly break. The tests pass either way. That's the judgment call.

---

## Task 6: The widget

**Files:**
- Modify: `bg_picker.js`

- [ ] **Step 1: Append `createBgPicker`**

Append to `bg_picker.js`. This is the DOM half; nothing here runs at import time, so the Task 4/5 tests keep working:

```js
// Long enough that dragging the cursor down 60 rows fires one fetch instead of
// 60; short enough to feel immediate on the row you actually stop on.
const HOVER_DELAY_MS = 80;
const POPOVER_W = 320;
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

  const list = document.createElement('div');
  list.className = 'bg-picker-list';
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
    if (el) list.setAttribute('aria-activedescendant', el.id);
    else list.removeAttribute('aria-activedescendant');
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
    activeValue = value;
    render();
    rowEl(value)?.scrollIntoView({ block: 'center' });
    filter.focus();
  }

  function close() {
    open = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
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
    setGroups(g) { groups = g; updateButton(); if (open) render(); },
    setValue(v) { value = v ?? ''; updateButton(); if (open) render(); },
    getValue() { return value; },
  };
}
```

- [ ] **Step 2: Check it parses and the model tests still pass**

Run: `node --check bg_picker.js && node --test tests/bg_picker.test.mjs`
Expected: no output from `--check`, then `# pass 16`

- [ ] **Step 3: Commit**

```bash
git add bg_picker.js
git commit -m "Add background picker widget with hover thumbnail preview"
```

---

## Task 7: Styling

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Append the rules**

Append to the end of `styles.css`. The palette variables are already defined at the top of the file:

```css
/* --- Background picker (scene editor, Adv mode) -------------------------
   Replaces a native <select>: browsers won't fire hover on <option> or render
   images inside it, and the background filenames are bare numbers. The popover
   shows the WebP thumbnail baked by scripts/build_bg_thumbs.py. */

.bg-picker { position: relative; }

.bg-picker-button {
  width: 100%;
  padding: 12px 16px;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 16px;
  text-align: left;
  cursor: pointer;
}
.bg-picker-button::after { content: '▾'; float: right; color: var(--text-muted); }
.bg-picker-button:hover { border-color: var(--active); }

.bg-picker-panel {
  position: absolute;
  z-index: 30;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 12px 32px #000a;
  overflow: hidden;
}

.bg-picker-filter {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-deep);
  color: var(--text);
  border: 0;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.bg-picker-filter:focus { outline: none; border-bottom-color: var(--active); }

.bg-picker-list { max-height: 360px; overflow-y: auto; padding: 4px 0; }

.bg-picker-group {
  padding: 6px 12px 3px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.bg-picker-row {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.bg-picker-row.active { background: #a78bfa22; box-shadow: inset 2px 0 0 var(--active); }
.bg-picker-row.selected { color: var(--active); }

.bg-picker-empty,
.bg-picker-missing {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.bg-picker-missing { max-width: 320px; white-space: normal; text-align: center; }

/* Fixed, not absolute: the popover is positioned from getBoundingClientRect,
   which is viewport-relative, and it must escape the list's overflow clip. */
.bg-picker-pop {
  position: fixed;
  z-index: 40;
  padding: 5px;
  background: var(--bg-deep);
  border: 1px solid var(--active);
  border-radius: 8px;
  box-shadow: 0 12px 30px #000b;
  pointer-events: none;
}
.bg-picker-thumb-box { width: 320px; min-height: 60px; }
.bg-picker-thumb { display: block; width: 320px; border-radius: 4px; }
.bg-picker-caption {
  display: block;
  padding: 4px 2px 0;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--active);
}
```

- [ ] **Step 2: Commit**

```bash
git add styles.css
git commit -m "Style the background picker and its preview popover"
```

---

## Task 8: Standalone test page

**Files:**
- Create: `bg_picker_test.html`

This mirrors `scene_court_test.html`, the repo's existing pattern for exercising a browser component on its own. It matters here because the picker must be checked on a clone with no art (the missing-thumbnail path) and on a real tree.

- [ ] **Step 1: Write the page**

`bg_picker_test.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Background Picker — Standalone Test</title>
<link rel="stylesheet" href="styles.css">
<style>
  body { margin: 0; background: #121214; color: #e8e6e3;
         font-family: -apple-system, "Segoe UI", sans-serif; }
  .wrap { width: 460px; padding: 24px; }
  .section-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
                   color: #8a8a8e; margin-bottom: 8px; }
  #log { margin-top: 20px; font: 12px ui-monospace, monospace; color: #8a8a8e;
         white-space: pre-wrap; }
</style>
</head>
<body>
<div class="wrap">
  <div class="section-label">Background</div>
  <div id="bgPicker"></div>
  <div id="log">onChange log:</div>
</div>

<script type="module">
import { createBgPicker } from './bg_picker.js';

// Mirrors scene.js's real derivation so this page exercises the same URLs.
const thumbUrl = (v) => {
  if (!v) return null;
  const m = v.match(/^(.*)\/(main|stills)\/(.+)\.png$/);
  return m ? `${m[1]}/thumbs/${m[2]}/${m[3]}.webp` : null;
};

const groups = [
  { label: null, items: [{ value: '', label: '(none — black)', pinned: true }] },
  { label: 'Main', items: [] },
  { label: 'Stills', items: [] },
];

// Fall back to invented rows so the page also works on a clone with no art —
// that's the missing-thumbnail path, which is worth being able to see.
try {
  const meta = await (await fetch('scene/backgrounds/meta.json')).json();
  groups[1].items = meta.main.map(e => (
    { value: `scene/backgrounds/main/${e.file}`, label: e.name }));
  groups[2].items = meta.stills.map(e => (
    { value: `scene/backgrounds/stills/${e.file}`, label: e.name }));
} catch {
  groups[1].items = Array.from({ length: 8 }, (_, i) => ({
    value: `scene/backgrounds/main/Background_0${23 + i}_001.png`,
    label: `Background_0${23 + i}_001`,
  }));
  groups[2].items = [{ value: 'scene/backgrounds/stills/Still_001_001.png',
                       label: 'Still_001_001' }];
  document.getElementById('log').textContent =
    'no meta.json — using invented rows; every popover should show the missing-thumb message';
}

const log = document.getElementById('log');
const picker = createBgPicker({
  mount: document.getElementById('bgPicker'),
  thumbUrl,
  onChange: (v) => { log.textContent += `\nonChange(${JSON.stringify(v)})`; },
});
picker.setGroups(groups);
picker.setValue(groups[1].items[0]?.value ?? '');
</script>
</body>
</html>
```

- [ ] **Step 2: Drive it**

Run: `python3 -m http.server 8080` and open `http://localhost:8080/bg_picker_test.html`

Walk every branch and confirm each:

| Check | Expected |
|---|---|
| Click the button | Panel opens, filter focused, current row centered |
| Hover a row, keep still | Popover appears beside it after a beat, showing that background |
| Sweep the cursor fast down the list | No flurry of popovers; only where you stop |
| Hover a row near the window's right edge | Popover flips to the left of the list, never off-screen |
| Click a row | Panel closes, button relabels, `onChange(...)` logged once |
| Type `023` | Only `*_023_*` rows plus `(none — black)` remain |
| Type `zzzz` | `no matches` shown, `(none — black)` still there |
| Arrow down/up | Highlight moves one row, previews as it goes, stops at the ends |
| Enter | Commits the highlighted row |
| Escape | Closes, focus back on the button |
| Hover `(none — black)` | No popover at all |
| Click outside the panel | Closes without an `onChange` |
| DevTools → toggle device toolbar (touch), tap a row | Previews; tapping it again commits; tapping a different row re-previews |
| Rename one thumb aside, hover its row | `no thumbnail — run scripts/build_bg_thumbs.py` |

- [ ] **Step 3: Commit**

```bash
git add bg_picker_test.html
git commit -m "Add standalone background picker test page"
```

---

## Task 9: Wire the picker into the scene editor

**Files:**
- Modify: `scene.html:45`
- Modify: `scene.js:11-12, 59, 718, 3198-3227, 4222-4226, 4510`

- [ ] **Step 1: Swap the markup**

`scene.html:45` — replace:

```html
    <select class="char-select" id="bgSelect"></select>
```

with:

```html
    <div id="bgPicker"></div>
```

- [ ] **Step 2: Import the module**

In `scene.js`, after the `snapshot_store.js` import block (ends at line 12), add:

```js
// Background picker widget. Dynamic import so the BUILD_VERSION query string
// busts module-script caches the same way the static asset URLs do.
const { createBgPicker } =
  await import(`./bg_picker.js?v=${BUILD_VERSION}`);
```

- [ ] **Step 3: Replace `populateBgSelect`**

In `scene.js`, replace the whole `populateBgSelect` function (lines 3198-3227) with:

```js
// Thumbnail URL for a background path, derived rather than recorded in
// meta.json — that keeps build_bg_thumbs.py independent of
// build_backgrounds_meta.py, and a recorded flag would lie the moment a thumb
// was deleted. A missing thumb 404s and the picker shows its own placeholder.
// Returns null for "(none — black)", which has nothing to preview.
function bgThumbUrl(bgFilePath) {
  if (!bgFilePath) return null;
  const m = bgFilePath.match(/^(.*)\/(main|stills)\/(.+)\.png$/);
  if (!m) return null;
  return assetUrl(`${m[1]}/thumbs/${m[2]}/${m[3]}.webp`);
}

const bgPicker = createBgPicker({
  mount: document.getElementById('bgPicker'),
  thumbUrl: bgThumbUrl,
  onChange: (v) => {
    bgPath = v || null;
    scheduleRender();
    scheduleSceneConfigSave();
  },
});

function populateBgPicker() {
  const groups = [
    { label: null, items: [{ value: '', label: '(none — black)', pinned: true }] },
  ];

  function addGroup(label, list, dir) {
    if (!list || list.length === 0) return;
    groups.push({
      label,
      items: list.map(e => ({ value: `${SCENE_BG_ROOT}/${dir}/${e.file}`, label: e.name })),
    });
  }
  addGroup('Main',   bgMeta.main,   'main');
  addGroup('Stills', bgMeta.stills, 'stills');
  // bgMeta.utility (Grid_001, Grid_002, SolidColor, Transparent) is omitted —
  // those are author/debug helpers, not narrative backgrounds.
  bgPicker.setGroups(groups);

  const first = bgMeta.main && bgMeta.main[0];
  bgPath = first ? `${SCENE_BG_ROOT}/main/${first.file}` : null;
  bgPicker.setValue(bgPath || '');
}
```

`const bgPicker` sits at module scope around line 3210. `init()` (`scene.js:4017`) runs after it, so nothing calls into the picker before it exists.

- [ ] **Step 4: Update the `populateBgSelect` call site**

`scene.js:4027`, inside `init()` — replace:

```js
  populateBgSelect();
```

with:

```js
  populateBgPicker();
```

- [ ] **Step 5: Remove the old change handler**

`scene.js:4222-4226` — delete these five lines. Their work now happens in the `onChange` callback from Step 3:

```js
  document.getElementById('bgSelect').onchange = (e) => {
    bgPath = e.target.value || null;
    scheduleRender();
    scheduleSceneConfigSave();
  };
```

- [ ] **Step 6: Update the state-restore call site**

`scene.js:716-719` — replace:

```js
  if (typeof data.bgPath === 'string' || data.bgPath === null) {
    bgPath = data.bgPath || null;
    document.getElementById('bgSelect').value = bgPath || '';
  }
```

with:

```js
  if (typeof data.bgPath === 'string' || data.bgPath === null) {
    bgPath = data.bgPath || null;
    bgPicker.setValue(bgPath || '');
  }
```

- [ ] **Step 7: Update the reset call site**

`scene.js:4510` — replace:

```js
    document.getElementById('bgSelect').value = bgPath || '';
```

with:

```js
    bgPicker.setValue(bgPath || '');
```

- [ ] **Step 8: Confirm no reference survives**

Run: `grep -n "bgSelect\|populateBgSelect" scene.js scene.html`
Expected: no output.

Run: `node --check scene.js`
Expected: no output.

- [ ] **Step 9: Bump the cache-busting versions**

`scene.js:3` — set `BUILD_VERSION` to `'20260717a'`.

`scene.html:518` and the `styles.css` link in `scene.html` — set both `?v=` values to `20260717a` to match.

Run: `grep -n "BUILD_VERSION = \|?v=" scene.js scene.html | head`
Expected: every `?v=` in `scene.html` and `BUILD_VERSION` in `scene.js` read `20260717a`.

- [ ] **Step 10: Commit**

```bash
git add scene.html scene.js
git commit -m "Replace scene background select with thumbnail picker"
```

---

## Task 10: Document the script

**Files:**
- Modify: `CLAUDE.md`

`CLAUDE.md` documents every script in `scripts/` and every generated artifact. Leaving it out would make the new script invisible to the next person.

- [ ] **Step 1: Add the script section**

In `CLAUDE.md`, after the `### scripts/build_backgrounds_meta.py` section and before `### scripts/extract_scene_adv.py`, insert:

````markdown
### `scripts/build_bg_thumbs.py`

Bakes the thumbnails the scene editor's background picker previews on hover. The source art is
4096×2048 and 5–10 MB per file — far too heavy to preview directly — so the picker shows these
instead.

```bash
python3 scripts/build_bg_thumbs.py [<root>]   # default root: ./scene/backgrounds
```

Reads `scene/backgrounds/meta.json` and processes its `main` and `stills` lists. The `utility`
list is skipped, matching the picker, which omits those author/debug helpers.

Outputs:
- `scene/backgrounds/thumbs/{main,stills}/{name}.webp` — 480×270 WebP, quality 80. About 10–30 KB
  each, ~3.5 MB for all 230. Gitignored, like every other generated image in the repo.

The crop mirrors `scene.js`'s `renderBackground`: cover-fit with `max(CANVAS_W/iw, CANVAS_H/ih)`,
then center-crop to 2560×1440. Source art is 2:1 but the stage is 16:9, so ~10% of image height
never reaches the screen; cropping any other way would make thumbnails promise framing the stage
won't deliver. **That correspondence is the script's one invariant — if `renderBackground` ever
changes its fit, change this script with it.**

Re-runnable and incremental: a thumbnail at least as new as its source is skipped, and thumbs whose
source is gone are pruned. A cold run over all 230 takes about a minute (decoding the 4096×2048
PNGs dominates, not the resize).

The picker derives the thumbnail URL as `thumbs/{dir}/{name}.webp` rather than reading it from
`meta.json`, so this script and `build_backgrounds_meta.py` stay independent. A missing thumbnail
404s and the picker shows a "run scripts/build_bg_thumbs.py" placeholder.
````

- [ ] **Step 2: Add the workflow step**

In `CLAUDE.md`, under "Bundle extraction workflow" → "2. Run the extractor", replace the background bulk-extraction block with:

````markdown
Background / still (bulk; the extractor is single-bundle, so loop over a directory):
```bash
for f in path/to/mainbackground/*.bundle; do python3 scripts/extract_background.py "$f" scene/backgrounds/main;   done
for f in path/to/stills/*.bundle;         do python3 scripts/extract_background.py "$f" scene/backgrounds/stills; done
python3 scripts/build_backgrounds_meta.py     # rebuild scene/backgrounds/meta.json
python3 scripts/build_bg_thumbs.py            # rebuild the picker's hover thumbnails
```
````

- [ ] **Step 3: Add the artifacts to the project structure list**

In `CLAUDE.md`, under "Project structure", after the `scene/backgrounds/meta.json` bullet, insert:

```markdown
- `scene/backgrounds/thumbs/{main,stills}/{name}.webp` — 480×270 WebP thumbnails previewed on hover by the scene editor's background picker. Stage-framed (same cover-fit + center-crop as `renderBackground`). Generated by `build_bg_thumbs.py`; gitignored.
```

And after the `scene/authors.json` bullet, insert:

```markdown
- `bg_picker.js` — The scene editor's background dropdown: a custom listbox that floats a thumbnail popover beside the hovered row (a native `<select>` can't — browsers don't fire hover on `<option>`). Its pure logic (`filterGroups`, `nextActiveValue`, `tapAction`) is exported DOM-free and tested by `tests/bg_picker.test.mjs`; `bg_picker_test.html` exercises the widget standalone.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the background thumbnail script and picker"
```

---

## Task 11: End-to-end verification

**Files:** none — this task only runs things.

Needs the real extracted art plus `python3 scripts/build_bg_thumbs.py` already run (Task 3).

- [ ] **Step 1: Run every test**

Run:

```bash
python3 -m pytest tests/ -v
node --test tests/bg_picker.test.mjs
node --check scene.js && node --check bg_picker.js
```

Expected: 11 passed, `# pass 16`, and no output from either `--check`.

- [ ] **Step 2: Drive the real editor**

Run: `python3 -m http.server 8080` and open `http://localhost:8080/scene.html`

| Check | Expected |
|---|---|
| Open the Background field | Panel lists `(none — black)`, Main (58), Stills (172) |
| Hover rows | Popover shows the right art, stage untouched |
| Click a row | Stage renders the *same* background the popover showed, at full resolution |
| Reload the page | The chosen background is still selected and rendered |
| Filter `023`, pick a row, reload | The filtered pick survives |
| Reset | Returns to `Background_001_001` |
| Pick `(none — black)` | Stage goes black; no popover was ever shown for that row |
| Switch to Debate/Trial scene type and back | Background field still works |
| DevTools Network tab, hover 10 rows | Ten ~10–30 KB `.webp` requests, no `.png` |

Step 3's last row is the one that matters most: it proves the picker previews thumbnails and not the 10 MB originals.

- [ ] **Step 3: Confirm no stray artifacts**

Run: `git status --short`
Expected: clean. Nothing under `scene/backgrounds/thumbs/` may appear.

---

## Self-review notes

Checked against `docs/superpowers/specs/2026-07-17-bg-thumbnail-picker-design.md`:

| Spec section | Task |
|---|---|
| §1 thumbnail pipeline, crop math, WebP 480×270 q80 | 1, 2 |
| §1 incremental, prune, CLI, `.gitignore`, no `meta.json` change | 2, 3 |
| §2 `createBgPicker` interface, `thumbUrl` → `null` | 4, 6 |
| §2 desktop hover + 80 ms delay, popover flip, click commits | 6, 8 |
| §2 touch tap-to-preview, second tap commits | 5, 6 |
| §2 keyboard ↑/↓/Enter/Esc | 4, 6 |
| §2 filter box, cross-group, pinned none-row | 4, 6 |
| §2 accessibility roles + `aria-activedescendant` | 6 |
| §3 four `scene.js` call sites, `bgPath` unchanged | 9 |
| §4 missing thumb placeholder, thumb cache, empty filter | 6, 8 |
| §5 styling from the existing palette | 7 |
| §Verification | 3, 8, 11 |

Task 10 (CLAUDE.md) has no spec section; it exists because the repo documents every script, and a plan that skips it leaves the script invisible.
