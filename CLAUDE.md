# manosaba_editor

## Scripts

The character and scene data is extracted directly from the game's Unity AssetBundles. There are four extractors and one probe; pick the extractor based on what `inspect_bundle.py` reports.

### `scripts/inspect_bundle.py`

Probes a Unity AssetBundle and prints what's inside (object inventory, Texture2D / Sprite summaries, GameObject hierarchy). Use this first to decide which extractor applies.

```bash
python3 scripts/inspect_bundle.py <bundle>
```

Decision rule:
- **Has GameObject + Transform + SpriteRenderer + Sprite** → layered character rig, use `extract_bundle.py`.
- **Has a single MonoBehaviour with a `sprites` list (Naninovel DicedSpriteAtlas) and no Transform tree** → NPC/creature, use `extract_diced_atlas.py`.
- **Has only one Texture2D + one Sprite (no Transform tree, no MonoBehaviour)** → full-frame scene asset (background / still), use `extract_background.py`.
- **Has SpriteAtlas objects with no Transform tree, OR has GameObject + RectTransform + Image MonoBehaviours** → UI bundles. Use `extract_ui_layers.py` and pass at least one of each kind together (one SpriteAtlas-bearing source bundle + one or more prefab bundles).

### `scripts/extract_bundle.py`

Extracts a layered character (Body, Arms, Eyes, Mouth, Effect_*, ClippingMask_*, …) from an AssetBundle into the renderer's `pos`-based schema.

```bash
python3 scripts/extract_bundle.py <bundle> <out_dir>
```

Outputs:
- `out_dir/{name}.png` — bbox-cropped sprite per layer (UnityPy resolves Sprite.image to the cropped, oriented PNG).
- `out_dir/layers.json` — `{ canvas_size: [W, H], layers: [{ name, group, order, empty, pos: [x, y], render: {...}, ... }] }`.

How it works:
1. Walks the GameObject/Transform tree, accumulating local positions to a world position per leaf.
2. For each leaf with a SpriteRenderer + Sprite, computes the sprite's pixel-space footprint from `m_Rect`, `m_Pivot`, and `m_PixelsToUnits`.
3. **Auto-grow canvas (option C)**: `canvas_size` is the bbox of every leaf footprint; nothing is hand-tuned.
4. Y is flipped from Unity (Y-up) to PIL (Y-down). `pos` is the top-left of the sprite on the canvas.
5. **`render` is derived from the SpriteRenderer's material**:
   - `blend` from the shader name (`Naninovel Extender/<Default|Multiply|Overlay|Softlight>` → `source-over` / `multiply` / `overlay` / `softlight`).
   - `stencil` from material props: `_StencilOp=2 (Replace) ∧ _StencilRef>0` → `{ role: "write", ref, cutoff? }`; `_StencilComp=4 (Equal) ∧ _StencilRef>0` → `{ role: "read", ref }`; otherwise null.
   - `tint` from `m_Color` when not `(1,1,1,1)`.
6. **Auto-derives `requires`** for layers whose name embeds an arm pose (e.g. `Effect_Back_ArmR07` → `requires: "ArmR07"`, `ArmL01_Softlight` → `requires: "ArmL01"`).

Re-running on an existing `out_dir` **preserves curation fields** in `layers.json` by merging on layer name: `group`, `requires`, `excludes_groups`, `requires_groups`, `auto_enable`. The `empty` flag and everything else (positions, render, order) is bundle-driven and overwritten.

### `scripts/extract_diced_atlas.py`

Extracts a Naninovel DicedSpriteAtlas — a flat list of full-frame poses with no rig — into the diced schema used for NPCs/creatures.

```bash
python3 scripts/extract_diced_atlas.py <bundle> <out_dir>
```

Outputs:
- `out_dir/{pose_name}.png` — one PNG per pose, padded to the shared `m_Rect` so every pose lands on a common canvas and aligns pixel-for-pixel.
- `out_dir/meta.json` — `{ type: "diced", name, canvas_size: [W, H], poses: [<sprite_name>, …] }`.

UnityPy reconstructs each diced sprite to its mesh-vertex bbox (smaller than `m_Rect`); `_pad_to_rect` re-anchors that reconstruction inside the full rect using the vertex bbox + rect origin. Poses are sorted with a natural-numeric key so `"10"` follows `"9"` instead of `"1"`.

### `scripts/extract_background.py`

Extracts a single full-frame image (background or still) from a Texture2D+Sprite-only bundle. The Sprite covers the entire texture, so we save the Texture2D directly — no rig walk, no diced reconstruction.

```bash
python3 scripts/extract_background.py <bundle> <out_dir>
```

Outputs:
- `out_dir/{m_Name}.png` — full-resolution PNG named after the asset's `m_Name` (e.g. `Background_001_001`, `Still_001_001`). Zero-padded so lexical sort = numeric sort.

Re-running on an existing PNG is a no-op (the file is preserved as-is). The script does not write `meta.json`; that is built separately by `build_backgrounds_meta.py` once all bundles are extracted.

### `scripts/extract_ui_layers.py`

Fused UI extractor: combines sprite-atlas extraction + RectTransform layout walking into a single pass. Emits two complementary views of the same data — atlas-keyed sprite folders (deduplicated PNGs + sprite-centric `layers.json` listing every prefab usage) and per-prefab layout files at the top level (drop-in compositor input, references PNGs by relative path).

```bash
python3 scripts/extract_ui_layers.py <out_dir> <bundle> [<bundle> ...]
```

Bundles are auto-classified: any bundle containing `SpriteAtlas` objects is treated as a sprite source; the rest are prefab bundles. Pass `general-sprites_assets_all.bundle` plus one or more UI prefab bundles in any order.

Output layout:

```
out_dir/
  <AtlasName>/
    <sprite_name>.png          # one PNG per unique sprite, deduplicated
    ...
    layers.json                # sprite-centric: { sprites: [{name, file, size, pivot, usages: [...]}, ...] }
  <PrefabName>.json            # prefab-centric: { canvas_size, name, source, layers: [...] }
  meta.json                    # { type: "ui_layout_index", canvas_size, atlases: [...], prefabs: [...] }
```

Per-prefab `<PrefabName>.json` schema (drop-in compositing input — mirrors `characters/{Character}/layers.json` shape, with `file` extended to a relative path):

```json
{
  "canvas_size": [2560, 1440],
  "name":   "NormalPrinter",
  "source": "naninovel-textprinters_assets_all.bundle",
  "layers": [
    {
      "name":  "NormalPrinter_Frame_Top",
      "file":  "UI_Adv/NormalPrinter_Frame_Top.png",  // relative to out_dir
      "go":    "Frame_Top",
      "atlas": "UI_Adv",
      "group": "Wrapper/Default-Stream",
      "order": 0,
      "pos":   [2273, 0],                              // top-left on canvas (PIL Y-down)
      "size":  [287, 470]                              // RectTransform-resolved size
    },
    ...
  ],
  "containers": [                                      // optional, non-rendered layout rules
    {
      "go":    "Content",
      "group": "Wrapper",
      "pos":   [1106, 787],
      "size":  [899, 0],                               // 0 dims = ContentSizeFitter will grow at runtime
      "pivot": [0.5, 0.5],                             // Unity Y-up pivot, [x, y] in [0..1]
      "layout_group": {
        "kind": "VerticalLayoutGroup",                 // or HorizontalLayoutGroup / GridLayoutGroup /
                                                       // HorizontalOrVerticalLayoutGroup (ambiguous)
        "padding": [0, 0, 0, 0],
        "spacing": 80.0,                               // float for HV; [x, y] for Grid
        "child_alignment": "MiddleRight",              // Unity TextAnchor enum
        "child_control_width": false,
        "child_control_height": false,
        "child_force_expand_width": false,
        "child_force_expand_height": false
        // Grid-specific extras: cell_size, start_corner, start_axis, constraint, constraint_count
      },
      "size_fitter": {
        "horizontal_fit": "Unconstrained",             // Unconstrained / MinSize / PreferredSize
        "vertical_fit":   "PreferredSize"
      },
      "placement": {                                   // pre-resolved geometry for compositors
        "kind": "vertical",                            // or "horizontal" or "grid"
        "x_anchor_canvas_pil": 2005,                   // children's cross-axis anchor on canvas
        "x_anchor_basis": "right",                     // "left" | "center" | "right"
        "y_pivot_canvas_pil": 787,                     // pivot point for column extension
        "y_pivot_position": 0.5,                       // 0=column-top in PIL, 1=column-bottom
        "spacing": 80.0,
        "padding_top": 0,
        "padding_bottom": 0
      }
    }
  ],
  "root_intrinsic_size": [1099, 318]                   // optional; set when root has non-zero size_delta.
                                                       // Indicates a *widget* prefab (e.g. ChoiceButton_Trial)
                                                       // whose natural size is what gets laid out under a
                                                       // parent layout group. Screen prefabs (NormalPrinter)
                                                       // omit this — their static layout fills the canvas.
}
```

The `containers` array describes **runtime layout rules**, not rendered geometry. A node appears here when its GameObject carries a `LayoutGroup` (Horizontal / Vertical / Grid) or `ContentSizeFitter` — these tell a compositor how children would be laid out when the prefab is populated at runtime by Naninovel's choice / list / menu drivers. Examples: `TrialChoicePanel/Wrapper/Content` is the `VerticalLayoutGroup` that stacks `ChoiceButton_Trial@*` instances; `GalleryUI/.../StillGrid` is the `GridLayoutGroup` (3-col 672×392) where unlocked stills get instantiated.

The `placement` field on each `containers[i]` (when the layout kind is unambiguous) provides pre-resolved canvas coordinates so a consumer doesn't need to redo the pivot/anchor math. Composing under a layout group reduces to plugging in N (child count) + a child size:

- **Grid**: enumerate cells via `first_cell_canvas_pil + (col * step.x, row * step.y)`. Wrap rows/columns by `constraint_count` based on `constraint` (FixedColumnCount / FixedRowCount). The `start_axis` controls fill order.
- **Vertical**: `column_height = N * child_h + (N-1) * spacing + padding_top + padding_bottom`; `column_top_pil = y_pivot_canvas_pil - column_height * y_pivot_position`. Each child's top: `column_top_pil + padding_top + k * (child_h + spacing)`. Cross-axis (x): `x_anchor_canvas_pil` adjusted by `x_anchor_basis` (`right` → subtract child_w; `center` → subtract child_w/2; `left` → use as-is).
- **Horizontal**: symmetric (swap x/y, column → row).

`HorizontalOrVerticalLayoutGroup` (kind that couldn't be specialized to H or V) gets no `placement` field — orientation must be inferred elsewhere or the layout simulated manually.

`HorizontalOrVerticalLayoutGroup` is the parent class of `HorizontalLayoutGroup` and `VerticalLayoutGroup` — the two are byte-identical in serialized typetree form (only the `m_Script` PPtr differs, which references an external Unity assembly we don't load). The script tries to specialize the label using the sibling `ContentSizeFitter` direction (e.g. `vertical_fit=PreferredSize` → `VerticalLayoutGroup`); when that's ambiguous (both axes constrained, or no fitter present), it stays as the parent-class label.

Per-atlas `<AtlasName>/layers.json` schema (sprite-centric — best for browsing or "where is this sprite used"):

```json
{
  "atlas": "UI_Adv",
  "canvas_size": [2560, 1440],
  "sprites": [
    {
      "name":  "Balloon_Default",
      "file":  "Balloon_Default.png",   // basename within this atlas dir
      "size":  [1099, 318],              // intrinsic sprite size
      "pivot": [0.5, 0.5],
      "usages": [
        { "prefab": "ChoiceButton_Trial", "go": "Balloon", "group": "...",
          "order": 0, "pos": [0, 0], "rect_size": [2560, 1440] },
        ...
      ]
    },
    ...
  ]
}
```

Optional fields, omitted when default: `color: [r,g,b,a]` if `Image.m_Color != (1,1,1,1)`, `material: "<name>"` if `Image.m_Material != null`. These appear on per-prefab layer entries and per-atlas usage entries.

Behaviours:
- **Empty prefabs** (templates with no Image-bearing leaves — e.g. `DebatePrinter`, `AdvChoicePanel`, `ClickThroughPanel`) are skipped: no JSON is written. The static prefab carries no positions for them; their content is filled at runtime.
- **CanvasGroup gating**: any subtree under a GameObject with `CanvasGroup.m_Alpha == 0` is skipped (handles NormalPrinter's hidden `Stream` template, etc.).
- **Root rect convention**: prefab roots' RectTransform fields are typically stubs because the prefab is parented under a Canvas at runtime. The walker treats the root's effective rect as the canvas regardless of serialized values; children measure against the full canvas.
- **Sprite deduplication**: each unique sprite is saved once into its atlas folder, regardless of how many prefabs reference it. Per-prefab JSONs and per-atlas usage lists both reference the single PNG.
- **Atlas filtering**: only atlases referenced by at least one extracted prefab get a folder. Sprites the prefabs don't actually use stay out of the output.

### `scripts/build_backgrounds_meta.py`

Scans `backgrounds/main/` and `backgrounds/stills/` and emits `backgrounds/meta.json` — a project-wide index for the scene editor.

```bash
python3 scripts/build_backgrounds_meta.py [<root>]   # default root: ./backgrounds
```

Output schema:
```json
{
  "main":    [{ "id": "NNN_MMM", "name": "Background_NNN_MMM", "file": "...png", "size": [W, H] }, ...],
  "stills":  [{ "id": "NNN_MMM", "name": "Still_NNN_MMM",      "file": "...png", "size": [W, H] }, ...],
  "utility": [{                  "name": "Grid_001",           "file": "...png", "size": [W, H], "from": "main" }, ...]
}
```

`utility` collects the non-numbered helpers shipped alongside numbered backgrounds (`Grid_001`, `Grid_002`, `SolidColor`, `Transparent`) so the scene editor can offer them as primitives without polluting the numbered list. Each utility entry carries a `from` field naming the directory it came from (currently always `main`). Numeric ids are zero-padded, so lexical sort yields the correct order.

## Bundle extraction workflow

### 1. Probe the bundle

```bash
python3 scripts/inspect_bundle.py path/to/CharacterX_bundle
```

Look at the object inventory and hierarchy depth to pick layered vs diced (see decision rule above).

### 2. Run the extractor

Layered:
```bash
python3 scripts/extract_bundle.py path/to/Alisa_bundle characters/Alisa
```

Diced:
```bash
python3 scripts/extract_diced_atlas.py path/to/Warden_bundle characters/Warden
```

Background / still (bulk; the extractor is single-bundle, so loop over a directory):
```bash
for f in path/to/mainbackground/*.bundle; do python3 scripts/extract_background.py "$f" backgrounds/main;   done
for f in path/to/stills/*.bundle;         do python3 scripts/extract_background.py "$f" backgrounds/stills; done
python3 scripts/build_backgrounds_meta.py     # rebuild backgrounds/meta.json
```

UI atlases + layouts (pass general-sprites as the sprite source plus every UI prefab bundle in one shot):
```bash
python3 scripts/extract_ui_layers.py ui \
  path/to/general-sprites_assets_all.bundle \
  path/to/naninovel-textprinters_assets_all.bundle \
  path/to/naninovel-choicehandlers_assets_all.bundle \
  path/to/general-choicebuttons_assets_all.bundle \
  path/to/naninovel-ui_assets_all.bundle
```

### 3. Curate `layers.json` (layered only)

The bundle gives geometry + render flags but not behavioural rules. Hand-add curation fields for the renderer's UI logic:

- `requires`: dependency on another layer (auto-derived for arm-pose names; add the rest).
- `excludes_groups`: when this layer activates, clear all layers in these group leaves (e.g. selecting `Arms01` clears `ArmL` + `ArmR`).
- `requires_groups`: `{ groupLeaf: defaultName }` — when this layer is cleared, ensure the named group has at least the listed default active.
- `auto_enable: true`: dependent layer flips on automatically when its `requires` parent toggles off→on.

Re-running `extract_bundle.py` preserves these fields, so curation survives bundle re-extraction.

### 4. Author `compositions.json` and `default.json` (layered only)

- `compositions.json` — expression presets: `{ "Normal1": ["Eyes_Normal_Open01", "Mouth_Normal_Closed01", ...] }`.
- `default.json` — initial state: `{ "enabled": ["Body", "ArmL01", ...] }` (single-head) or `{ "Head01": { "enabled": [...] }, "Head02": { "enabled": [...] } }` (multi-head).

These files are not generated by the extractors — they encode editorial choices about which combinations make sense for the UI.

## Project structure

- `characters/{Character}/` — Layered character output. Contains `layers.json`, `compositions.json`, `default.json`, and one PNG per layer.
- `characters/{Character}/layers.json` — Canvas size and per-layer geometry + render descriptor + curation fields. Generated by `extract_bundle.py`.
- `characters/{Character}/compositions.json` — Expression presets (facial layer sets). Hand-authored.
- `characters/{Character}/default.json` — Default enabled layers on load. Hand-authored.
- `characters/{NPC}/` — Diced atlas output. Contains `meta.json` and one PNG per pose. Generated by `extract_diced_atlas.py`.
- `backgrounds/main/{Background_NNN_MMM}.png` — Numbered scene backgrounds. Generated by `extract_background.py`.
- `backgrounds/stills/{Still_NNN_MMM}.png` — Numbered story stills / event CGs. Generated by `extract_background.py`.
- `backgrounds/meta.json` — Project-wide index of all backgrounds + stills + utility primitives. Generated by `build_backgrounds_meta.py`.
- `ui/<AtlasName>/<sprite>.png`, `ui/<AtlasName>/layers.json` — Per-atlas folders: deduplicated sprite PNGs plus sprite-centric `layers.json` (each sprite's `usages` list shows every prefab that places it). Generated by `extract_ui_layers.py`.
- `ui/<PrefabName>.json`, `ui/meta.json` — Per-prefab compositing inputs at the top level (drop-in `layers.json`-style format with `file` paths pointing into the atlas folders) plus a top-level index of all atlases and prefabs. Generated alongside the atlas folders by the same script.
- `_ref/`, `characters/{Character}/crop/`, `_backup/` — Artifacts of the previous sprite-sheet pipeline. Not used by the current extractors or renderer; kept for reference.

## Frontend (`index.html` + `styles.css` + `app.js`)

Standalone HTML/CSS/JS character portrait editor. Serve with `python3 -m http.server 8080`.

### Data files per character

**Layered characters:**
- **`layers.json`** — `{ canvas_size: [W, H], layers: [...] }`. Each layer has:
  - `name`, `group`, `order` (sort key, descending = drawn later = on top).
  - `pos: [x, y]` — top-left of the sprite on the canvas.
  - `empty` — placeholder slot in the prefab; skip in the renderer.
  - `render: { blend, stencil, tint? }` — see "Render pipeline" below.
  - Curation: `requires` (string or string[]), `excludes_groups`, `requires_groups`, `auto_enable`.
- **`compositions.json`** — `{ "Normal1": ["LayerA", ...], ... }`. Multi-head characters number variants per head (`Normal1` for Head01, `Normal2` for Head02). The active preset is computed by comparing the current facial layers against each preset's enabled list.
- **`default.json`** — `{ "enabled": [...] }` or `{ "Head01": { "enabled": [...] }, ... }`.

**Diced NPCs:**
- **`meta.json`** — `{ type: "diced", name, canvas_size, poses: [...] }`. The renderer takes a separate code path: no layer panel, just a pose selector.

There is no separate `clipping.json` file — clipping behavior is encoded in each layer's `render.stencil`.

### UI layout

Left panel (460px desktop; mobile drawer below 900px):
1. **Character selector** — dropdown.
2. **Head selector** — buttons for Head01/Head02 (only shown for multi-head characters: Ema, Hiro, Meruru).
3. **Pose selector** (diced only) — replaces presets/groups for NPCs.
4. **Expression presets** — pill buttons (Normal, Smile, Angry, …). Filtered by active head; active state is determined by comparing current facial layers against the preset's enabled list.
5. **Layer groups** — collapsible sections. Order: Eyes/Mouth/Cheeks → Pale/Sweat/Mask → ArmL → ArmR → Arms → Option_Arm* → Effect_*_Arm* → Shadow_Arm* → rest. Effect family siblings (e.g. `Effect_Back_ArmR01..09`) are bucketed under a synthetic `__EffectMask__/...` group regardless of how the bundle nested them.
6. **Action buttons** — Reset, Export PNG.

Right panel: live preview with zoom (scroll wheel, +/- buttons, 1:1 reset) and pan (click+drag on desktop, single-finger drag + pinch-to-zoom on touch).

### Key behaviours

- **Mutual exclusion** is driven by `excludes_groups` / `requires_groups` on the activating layer (e.g. `Arms01` declares `excludes_groups: ["ArmL", "ArmR"]` and `requires_groups: { ArmL: "ArmL01", ArmR: "ArmR01" }`).
- **Layer dependencies**: layers with `requires` are disabled when any required layer is inactive. Deselecting a required layer auto-disables its dependents (iterated until stable for chained `A→B→C`).
- **Auto-enable on activation**: a dependent with `auto_enable: true` flips on when its `requires` parent toggles off→on; the user can disable it manually afterwards.
- **Head switching**: changes active head base, clears the old head's layers, applies the new head's Normal preset, rebuilds presets and groups.
- **Always-on bases** (hidden from panel): `Body`, `Body\d+`, anything starting with `HeadBase`. Disabling them produces a broken composite.
- **Stencil readers as decorative overlays** (`render.stencil.role === "read"`): preset-independent — they're not cleared/restored when applying expression presets, so the user keeps direct on/off control.

### Render pipeline

Every layer carries `render = { blend, stencil, tint? }` derived from its Unity material. The compositor is a single z-ordered pass:

**Pass 1: build per-ref stencil buffers.**
For each `ref` value, walk all *writers* (layers with `render.stencil.role === "write"`, ref matching) and union their `α > cutoff·255` footprints into a 1-bit-per-pixel-equivalent buffer covering the full canvas. Multiple writers contribute by union.

**Pass 2: composite all layers in z-order.**
For each enabled, non-empty layer:
1. **Pre-tint** by `render.tint` if present (per-channel multiply against the sprite's RGB; α scaled by `tint[3]`). This mirrors Unity's `fragment_color = texture · m_Color`.
2. **Stencil-gate** (readers only): mask the sprite by the buffer for `render.stencil.ref` — output α = sprite.α × (1 if buffer set, else 0) at the corresponding canvas position.
3. **Blit** with `render.blend`:
   - `source-over` → Canvas2D `drawImage` (built-in, fast path).
   - `multiply` / `overlay` / `softlight` → per-pixel kernel via `getImageData` + `putImageData`.

#### Per-pixel blend kernels

All three non-`source-over` blends use the same kernel structure on a clipped rect:

```
for each pixel where αb > 0 and αs > 0:
    as = αs / 255
    Cout = blend(Cb, Cs)              // depends on mode (below)
    out  = Cout · as + Cb · (1 - as)  // mix unblended dest at AA edges
    αout = αb                         // preserved
```

Mode formulas (operating on 0–255):
- **multiply**: `Cmul = Cb · Cs / 255`.
- **overlay**: `Cb < 128 ? 2·Cb·Cs / 255 : 255 − 2·(255−Cb)·(255−Cs) / 255`.
- **softlight** (Pegtop, normalized to [0,1]): `Cout = (1 − 2·Cs')·Cb'² + 2·Cb'·Cs'`.
- Unknown mode → pass through as `source-over` color.

Guarantees:
- **Anti-aliasing preserved** — `αout = αb`, so a layer never adds visible pixels outside the existing canvas content.
- **Short-circuits** — `αb = 0` or `αs = 0` skip the kernel; transparent masks/regions cost almost nothing.
- **No mask-color leak at AA edges** — the `(1-as)` factor mixes the unblended dest back in, matching Canvas2D's `source-over` AA behaviour.

Cost: one `getImageData` + `putImageData` per non-`source-over` layer per render. Real arithmetic only runs inside the layer footprint.

Why not `globalCompositeOperation` for these blends: Canvas2D's W3C blend formula `Cs' = (1-αb)·Cs + αb·B(Cb,Cs)` injects mask color at anti-aliased dest edges and forces `αout` toward 1 inside the source's footprint. Both are wrong for "darken/blend color but preserve silhouette" — exactly what these character mask/overlay layers want.

### Color palette (CSS variables)

```
--bg-deep: #121214     (page background)
--bg-panel: #1c1c21    (left panel)
--bg-card: #26262d     (raised surfaces — groups, buttons)
--accent: #ff6b4a      (coral — presets, export button)
--active: #a78bfa      (soft violet — selected layers, group status)
--text: #e8e6e3        (primary text)
--text-muted: #8a8a8e  (secondary text)
--border: #333338      (borders)
```
