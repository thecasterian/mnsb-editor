# Compositing the Trial choice screen

How to reproduce the in-game Trial choice screen: a witness/lawyer portrait + N runtime-instantiated `ChoiceButton_Trial_*` widgets, arranged by a `VerticalLayoutGroup` over a scene background.

For the foundational rules — RectTransform → canvas math, canvas conventions (2560×1440, Y-flip), background fit-cover, linear-space alpha compositing — see [`adv_ui_compositing.md`](./adv_ui_compositing.md). This document covers only the trial-specific pieces: panel chrome, runtime layout, button structure.

A working reference implementation is `scripts/compose_ui_panel.py`; sample outputs at the bottom.

## Render order (back to front)

1. **Background** — full-canvas scene image (`backgrounds/main/<...>.png`), cover-fit to 2560×1440.
2. **Panel chrome** — `ui/TrialChoicePanel_Hiro.json` or `..._Ema.json`. Two static layers: a backdrop and a witness portrait anchored to the right edge.
3. **Choice buttons** — N copies of `ui/ChoiceButton_Trial_<variant>.json`, positioned by walking the `Content` container's `VerticalLayoutGroup` formula and pasting each button's layers at the resolved offset.

Compared to Adv mode, the trial layout is *runtime-driven*: the buttons aren't in the panel prefab at all — they're instantiated by Naninovel's choice handler, with positions computed from the layout group's settings + the actual button count.

## Panel chrome

Both `TrialChoicePanel_Hiro` and `TrialChoicePanel_Ema` share the same structure (only the portrait sprite differs). From `ui/TrialChoicePanel_Hiro.json`:

| Layer | Sprite | Atlas | `pos` (PIL) | `size` |
|---|---|---|---|---|
| `TrialChoiceBase` | `TrialChoiceBase` | `UI_Trial` | `[0, 0]` | `[2560, 1440]` |
| `ChoicePortrait_Hiro` | `ChoicePortrait_Hiro` | `UI_Trial` | `[1470, 0]` | `[1090, 1440]` |

`ChoicePortrait_Ema` lands at `[1614, 0]` size `[946, 1440]` — different sprite width, but the same right edge at `x=2560`. Both portraits are right-anchored via RectTransform `anchor_min=anchor_max=(1, 0)`, `pivot=(1, 0)`, so their right edge tracks the canvas right regardless of sprite size.

### Atlas-trim padding (subtle but load-bearing)

`ChoicePortrait_Hiro.png` is **1090×1440** on disk, but the visible witch occupies only x ∈ [299, 1089] inside it — the left **299 px is fully transparent**. This is intentional: Unity's `SpriteAtlas` packer strips empty margins (`m_RD.textureRectOffset.x = 299.08`), and `extract_ui_layers.py` re-pads the sprite back to the sprite's full `m_Rect` size at extraction time so it aligns 1:1 with the layer's RectTransform-derived `size`.

Without this padding the sprite would be 791×1440, and a compositor that resizes-to-fit would horizontally stretch the witch by 38% to fill the 1090-wide rect — visually wrong because Unity's actual rendering at runtime offsets the trimmed texture inside the rect rather than stretching it. The padded extraction matches Unity's runtime behavior pixel-for-pixel.

## Choice button placement

`TrialChoicePanel/Wrapper/Content` is a 0-height container at canvas pivot `(1555.5, 653.2)` (Unity Y-up) that auto-grows vertically to fit children. From `ui/TrialChoicePanel_Hiro.json`:

```json
{
  "containers": [{
    "go": "Content",
    "pos":  [1106, 787],
    "size": [899, 0],
    "pivot": [0.5, 0.5],
    "layout_group": {
      "kind": "VerticalLayoutGroup",
      "padding": [0, 0, 0, 0],
      "spacing": 80.0,
      "child_alignment": "MiddleRight",
      "child_control_width":       false,
      "child_control_height":      false,
      "child_force_expand_width":  false,
      "child_force_expand_height": false
    },
    "size_fitter": {
      "horizontal_fit": "Unconstrained",
      "vertical_fit":   "PreferredSize"
    },
    "placement": {
      "kind": "vertical",
      "x_anchor_canvas_pil": 2005,
      "x_anchor_basis": "right",
      "y_pivot_canvas_pil": 787,
      "y_pivot_position": 0.5,
      "spacing": 80.0,
      "padding_top": 0,
      "padding_bottom": 0
    }
  }]
}
```

The placement formula derives (in PIL Y-down, mixed-height aware):

```
total_h        = sum(child_h_i for i in range(N)) + (N-1) * spacing + padding_top + padding_bottom
column_top_y   = y_pivot_canvas_pil − total_h * y_pivot_position
                 = 787 − total_h * 0.5
button_k_top_y = column_top_y + padding_top
                 + sum(child_h_i for i in range(k))
                 + k * spacing
button_k_left_x = x_anchor_canvas_pil − child_w_k     (because x_anchor_basis = "right")
```

The mixed-height aware sum is **load-bearing**: the Cancel button is 229 px tall while the others are 318 px. A naive `N * child_h` formula computes wrong positions when heights differ. Each button's left edge moves with its width too (Cancel is 767 wide → left edge at 2005 − 767 = 1238; the other buttons at 1099 wide → left edge at 906) since `MiddleRight` aligns the right edge.

### Worked example: N = 3 (`MagicMargo`, `Question`, `Cancel`)

- Heights `[318, 318, 229]`, widths `[1099, 1099, 767]`, spacing 80.
- `total_h = 318+318+229 + 2*80 = 1025`.
- `column_top = 787 − 1025*0.5 = 274.5`.

| k | Widget | (w, h) | Top y (PIL) | Left x (PIL) |
|---|---|---|---|---|
| 0 | `MagicMargo` | (1099, 318) | 275 | 906 |
| 1 | `Question`   | (1099, 318) | 275 + 318 + 80 = 673 | 906 |
| 2 | `Cancel`     | (767, 229)  | 275 + 318 + 80 + 318 + 80 = 1071 | 1238 |

Comfortably within canvas y ∈ [275, 1300]; 140 px clearance from the canvas top, 140 px from the bottom.

### Choice budget

| N | Column height | Column y range (PIL) | Verdict |
|---|---|---|---|
| 2 | 627  | [474, 1101]  | Generous breathing room. |
| 3 | 1025 | [275, 1300]  | Comfortable. |
| 4 | 1423 | [76, 1499]   | Tight; Cancel's bottom (~59 px) crops at canvas edge. |
| 5 | 1910 | [-168, 1742] | Overflows top + bottom; topmost button mostly cut off. |

The trial panel has no `ScrollView` and no max-height clamp — the design budget is **N ≤ 3 comfortable, 4 tight with a short Cancel as the tail, never 5**. The shorter Cancel sprite (229 vs 318) is what enables N=4 to fit at all, and is a deliberate art-team budget choice.

## Choice button structure

A `ChoiceButton_Trial_*` prefab is a *widget* (root has non-zero `size_delta`), so its layers are stored in the button's intrinsic frame (1099×318, or 767×229 for Cancel). From `ui/ChoiceButton_Trial_MagicMargo.json`:

```json
{
  "canvas_size": [1099, 318],
  "name": "ChoiceButton_Trial@MagicMargo",
  "root_intrinsic_size": [1099, 318],
  "layers": [
    { "name": "Balloon_Default", "file": "UI_Trial/Balloon_Default.png",
      "go":   "ChoiceButton_Trial@MagicMargo",
      "pos":  [0, 0],   "size": [1099, 318] },
    { "name": "Magic_Purple@Ja", "file": "UI_Trial/Magic_Purple@Ja.png",
      "go":   "Tag",
      "pos":  [40, -47], "size": [199, 172] }
  ]
}
```

Two layers: the balloon (filling the button rect) and a tag (the magic-color badge or speech-act label).

The tag's `pos = [40, -47]` is **above the balloon** — the tag sticks 47 px upward from the button's top edge with 40 px of left inset, by design. The bottom 125 px of the tag overlaps the balloon's upper region. When the button is composited at panel position `(px, py)`, the tag lands at `(px + 40, py − 47)`. The compositor's clip-on-paste handles the negative y gracefully (no manual mask needed).

Variant tags by name: `Magic_<color>@<locale>` for magic accusations, `Doubt@<locale>` for `Question`, `Objection@<locale>` / `Perjury@<locale>` for the corresponding shouts, `Agreement@<locale>` for `Approval`. Cancel and Adv-bad variants have no tag.

### Locale note

The buttons in this game's Korean build use the `@ZhHans` localization slot for Korean glyphs (e.g., 마법 / 질문 / 반론 / 위증). The `@Ja` slot holds the original Japanese text. There is no `@Ko` atlas — the Korean release shipped Korean assets in the `@ZhHans` slot, presumably to reuse the same atlas-name conventions across SEA region builds. Any compositor that hard-codes a locale should default to `@ZhHans` for the Korean build, `@Ja` for the Japanese build.

## Reference compositor

`scripts/compose_ui_panel.py` (CLI):

```bash
python3 scripts/compose_ui_panel.py <PanelName> "<widget1>,<widget2>,..." <out.png> [<bg.png>]
# Pass "-" or "" for the widget list to render only the panel chrome.
```

Uses `ui/<PanelName>.json` + `ui/<widget_i>.json` directly. Linear-space alpha compositing throughout. Resizes each layer's sprite to its `size` field when they differ (a no-op for sprites that pack flush, used for any genuinely-stretched Unity Image renders).

Sample invocations (output to `/tmp` for inspection):

```bash
# 2 choices: Question + Cancel
python3 scripts/compose_ui_panel.py TrialChoicePanel_Hiro \
  ChoiceButton_Trial_Question,ChoiceButton_Trial_Cancel \
  /tmp/trial_2choices.png backgrounds/main/Background_002_001.png

# 3 choices: MagicMargo + Question + Cancel (typical configuration)
python3 scripts/compose_ui_panel.py TrialChoicePanel_Hiro \
  ChoiceButton_Trial_MagicMargo,ChoiceButton_Trial_Question,ChoiceButton_Trial_Cancel \
  /tmp/trial_3choices.png backgrounds/main/Background_002_001.png

# 4 choices: tight but still fits if Cancel is the tail
python3 scripts/compose_ui_panel.py TrialChoicePanel_Hiro \
  ChoiceButton_Trial_MagicMargo,ChoiceButton_Trial_Question,ChoiceButton_Trial_Objection,ChoiceButton_Trial_Cancel \
  /tmp/trial_4choices.png backgrounds/main/Background_002_001.png
```

The same compositor handles `AdvChoicePanel` (vertical layout, negative spacing, `UpperLeft` align with `ChildForceExpandWidth=true`) and `DebugChoicePanel` (3-col grid in a scroll view) by following the same `placement` formulas — only `LayoutGroup.kind` switches the math.

## Things this composite does *not* model

- **Button text** (the choice text inside `Label`) — TextMeshPro at runtime; not a sprite.
- **Hover / pressed states** — the button prefab carries one Image (`Balloon_Default`); other states (`Balloon_Selected`, `Balloon_Cancel` for the focus ring) are swapped at runtime by the choice handler script.
- **Scripted choice ordering or filtering** — the Naninovel `@trial` command picks the buttons; we just need a list.
- **Camera post-processing** — color grading, bloom, exposure compensation; not in any AssetBundle.
- **Underlay alpha animation** — `TrialChoicePanel/Underlay` fades in/out at runtime (CanvasGroup tweens) but the static prefab has alpha=1.

★ Insight ─────────────────────────────────────
- The panel is **deliberately spartan** at the static-prefab level: just a backdrop + portrait + a layout-group container. All the dynamism (buttons, count, ordering, locale) is runtime data that the script provides. This makes the prefab tiny (only 2 image layers) but means the data isn't sufficient to render a complete trial scene without supplying the choice list externally — exactly the contract a UI editor or scene-replay tool should expose.
- Trial-mode choices are **right-anchored** because Hiro/Ema occupy the right side of the canvas and the choices need to sit visually adjacent to whoever the player is debating. Adv-mode choices use `UpperLeft` align + `ChildForceExpandWidth=true` because Adv mode has no portrait — choices float over an empty backdrop and stretch to fill the column. The same `LayoutGroup` component, two completely different visual behaviours, encoded entirely in `ChildAlignment` + `ChildForceExpand*` flags.
- `MiddleRight` alignment + per-button width tracking is what enables `Cancel` (767 wide) to sit further to the right than `MagicMargo` (1099 wide), preserving the right-edge alignment despite different widths. This lets the same panel host wide "magic accusation" buttons and a narrow "back out" button without art-team rework.
─────────────────────────────────────────────────
