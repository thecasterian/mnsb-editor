#!/usr/bin/env python3
"""Reference compositor: render a panel + a list of widget instances.

Inputs:
  panel_name           — e.g. "TrialChoicePanel_Hiro"
  widget_names         — list of e.g. ["ChoiceButton_Trial_MagicMargo", ...]
  background (optional) — a backgrounds/main/*.png path
  out_path             — where to save the composite

Pipeline:
  1. (optional) cover-fit background onto a 2560x1440 canvas.
  2. Render panel's static layers (TrialChoiceBase, ChoicePortrait_*, ...).
  3. For each `containers[i]` with a `placement`, walk widget_names through
     the placement formula to compute each widget's PIL top-left on the panel
     canvas. The widget's intrinsic frame size comes from its own canvas_size.
  4. For each widget, render its layers onto the panel canvas, translated by
     the placement-determined offset.

Linear-space alpha compositing throughout (Unity Linear color space convention).
"""
from __future__ import annotations
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image

UI_ROOT = Path("ui")
CANVAS_W, CANVAS_H = 2560, 1440


# --- linear-space alpha compositing ---------------------------------------

def srgb_to_linear(x):
    a = 0.055
    return np.where(x <= 0.04045, x / 12.92, ((x + a) / (1 + a)) ** 2.4)

def linear_to_srgb(x):
    a = 0.055
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, (1 + a) * (x ** (1 / 2.4)) - a)

def load_linear(path: Path) -> np.ndarray:
    a = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0
    a[..., :3] = srgb_to_linear(a[..., :3])
    return a

def save_srgb(arr: np.ndarray, path: Path) -> None:
    out = arr.copy()
    out[..., :3] = linear_to_srgb(out[..., :3])
    out = np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(out, mode="RGBA").save(path)

def composite(dst: np.ndarray, src: np.ndarray, xy: tuple[int, int]) -> None:
    """Linear-space alpha-composite src onto dst at PIL (x, y), with clipping."""
    dx, dy = xy
    sh, sw = src.shape[:2]
    dh, dw = dst.shape[:2]
    x0, y0 = max(0, dx), max(0, dy)
    x1, y1 = min(dw, dx + sw), min(dh, dy + sh)
    if x1 <= x0 or y1 <= y0:
        return
    s = src[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    d = dst[y0:y1, x0:x1]
    sa = s[..., 3:4]
    d[..., :3] = s[..., :3] * sa + d[..., :3] * (1 - sa)
    d[..., 3:4] = sa + d[..., 3:4] * (1 - sa)


def fit_cover(arr: np.ndarray, target_w: int, target_h: int) -> np.ndarray:
    rgb  = linear_to_srgb(arr[..., :3])
    rgba = np.clip(np.dstack([rgb, arr[..., 3:4]]) * 255 + 0.5, 0, 255).astype(np.uint8)
    img = Image.fromarray(rgba, mode="RGBA")
    iw, ih = img.size
    s = max(target_w / iw, target_h / ih)
    img = img.resize((int(round(iw * s)), int(round(ih * s))), Image.LANCZOS)
    nw, nh = img.size
    left, top = (nw - target_w) // 2, (nh - target_h) // 2
    img = img.crop((left, top, left + target_w, top + target_h))
    a = np.asarray(img, dtype=np.float32) / 255.0
    a[..., :3] = srgb_to_linear(a[..., :3])
    return a


# --- prefab + layer rendering ---------------------------------------------

_SPRITE_CACHE: dict[str, np.ndarray] = {}
_RESIZE_CACHE: dict[tuple[str, int, int], np.ndarray] = {}

def load_sprite(rel_path: str) -> np.ndarray:
    if rel_path not in _SPRITE_CACHE:
        _SPRITE_CACHE[rel_path] = load_linear(UI_ROOT / rel_path)
    return _SPRITE_CACHE[rel_path]


def sprite_at_size(rel_path: str, target_w: int, target_h: int) -> np.ndarray:
    """Return the sprite stretched to (target_w, target_h). Unity's Image
    component with m_Type=Simple stretches the sprite to fill its rect; our
    layer's `size` is the resolved RectTransform rect size on canvas. Sprites
    are usually authored smaller than their UI rect (e.g. ChoicePortrait_Hiro
    is 791x1440 but renders into a 1090x1440 rect)."""
    base = load_sprite(rel_path)
    bh, bw = base.shape[:2]
    if bw == target_w and bh == target_h:
        return base
    key = (rel_path, target_w, target_h)
    if key in _RESIZE_CACHE:
        return _RESIZE_CACHE[key]
    # Roundtrip through sRGB bytes so PIL's LANCZOS does the resample.
    # Gamma-aware resize would be pure-linear, but the visual delta on
    # near-uniform UI sprites is negligible and not the bug we're fixing.
    rgb  = linear_to_srgb(base[..., :3])
    rgba = np.clip(np.dstack([rgb, base[..., 3:4]]) * 255 + 0.5, 0, 255).astype(np.uint8)
    img  = Image.fromarray(rgba, mode="RGBA").resize((target_w, target_h), Image.LANCZOS)
    a = np.asarray(img, dtype=np.float32) / 255.0
    a[..., :3] = srgb_to_linear(a[..., :3])
    _RESIZE_CACHE[key] = a
    return a


def render_prefab_layers(prefab: dict, canvas: np.ndarray,
                         offset_xy: tuple[int, int] = (0, 0)) -> None:
    """Render prefab['layers'] onto `canvas` at `offset_xy`. Pre-tints by
    optional `color` field; resizes sprite to layer's `size` (Unity Image
    stretches sprite-to-rect). Sibling order = z-order (back to front)."""
    for layer in prefab["layers"]:
        tw, th = layer["size"]
        if tw <= 0 or th <= 0:
            continue
        sprite = sprite_at_size(layer["file"], tw, th)
        color = layer.get("color")
        if color and color != [1, 1, 1, 1]:
            sprite = sprite.copy()
            sprite[..., :3] *= np.array(color[:3], dtype=np.float32)
            sprite[..., 3]  *= color[3]
        x = offset_xy[0] + layer["pos"][0]
        y = offset_xy[1] + layer["pos"][1]
        composite(canvas, sprite, (x, y))


# --- layout-group placement resolution ------------------------------------

def child_position(placement: dict, child_sizes: list[tuple[int, int]],
                   k: int) -> tuple[int, int]:
    """Return PIL top-left of child k under a placement formula.

    child_sizes is the full list of (w, h) for every child being placed —
    needed because Unity's HV layout groups sum *each* child's main-axis
    size, not N copies of one size. Cross-axis (alignment) anchor uses only
    child k's own size."""
    kind = placement["kind"]
    cw, ch = child_sizes[k]

    if kind == "vertical":
        spacing = placement["spacing"]
        col_h = (sum(h for _, h in child_sizes)
                 + (len(child_sizes) - 1) * spacing
                 + placement["padding_top"]
                 + placement["padding_bottom"])
        col_top = placement["y_pivot_canvas_pil"] - col_h * placement["y_pivot_position"]
        y = (col_top + placement["padding_top"]
             + sum(child_sizes[i][1] for i in range(k))
             + k * spacing)
        anchor_x = placement["x_anchor_canvas_pil"]
        if placement["x_anchor_basis"] == "right":
            x = anchor_x - cw
        elif placement["x_anchor_basis"] == "left":
            x = anchor_x
        else:
            x = anchor_x - cw / 2
        return (int(round(x)), int(round(y)))

    if kind == "horizontal":
        spacing = placement["spacing"]
        row_w = (sum(w for w, _ in child_sizes)
                 + (len(child_sizes) - 1) * spacing
                 + placement["padding_left"]
                 + placement["padding_right"])
        row_left = placement["x_pivot_canvas_pil"] - row_w * placement["x_pivot_position"]
        x = (row_left + placement["padding_left"]
             + sum(child_sizes[i][0] for i in range(k))
             + k * spacing)
        anchor_y = placement["y_anchor_canvas_pil"]
        if placement["y_anchor_basis"] == "bottom":
            y = anchor_y - ch
        elif placement["y_anchor_basis"] == "top":
            y = anchor_y
        else:
            y = anchor_y - ch / 2
        return (int(round(x)), int(round(y)))

    if kind == "grid":
        col_count = placement["constraint_count"]
        row, col = divmod(k, col_count)
        if placement.get("start_axis") == "Vertical":
            col, row = divmod(k, col_count)
        x = placement["first_cell_canvas_pil"][0] + col * placement["step"][0]
        y = placement["first_cell_canvas_pil"][1] + row * placement["step"][1]
        return (int(round(x)), int(round(y)))

    raise ValueError(f"Unknown placement kind: {kind}")


# --- top-level compose -----------------------------------------------------

def compose_panel(panel_name: str, widget_names: list[str],
                  background_path: Path | None, out_path: Path) -> None:
    panel = json.loads((UI_ROOT / f"{panel_name}.json").read_text())
    if panel["canvas_size"] != [CANVAS_W, CANVAS_H]:
        raise ValueError(f"Expected panel canvas {CANVAS_W}x{CANVAS_H}, got {panel['canvas_size']}")

    if background_path:
        canvas = fit_cover(load_linear(background_path), CANVAS_W, CANVAS_H)
    else:
        canvas = np.zeros((CANVAS_H, CANVAS_W, 4), dtype=np.float32)
        canvas[..., 3] = 1.0  # opaque black

    # 1. Panel's static chrome.
    print(f"# Panel '{panel['name']}': {len(panel['layers'])} layers")
    render_prefab_layers(panel, canvas)

    # 2. For each layout-driven container, place widget instances.
    widgets = [json.loads((UI_ROOT / f"{n}.json").read_text()) for n in widget_names]
    child_sizes = [tuple(w["canvas_size"]) for w in widgets]
    for c in panel.get("containers", []):
        placement = c.get("placement")
        if placement is None:
            continue
        print(f"# Container {c['go']}: {placement['kind']} layout, {len(widgets)} widget(s)")
        for k, (wname, widget) in enumerate(zip(widget_names, widgets)):
            xy = child_position(placement, child_sizes, k)
            print(f"  widget {k} ({wname}): {child_sizes[k][0]}x{child_sizes[k][1]} @ pil={xy}")
            render_prefab_layers(widget, canvas, offset_xy=xy)

    save_srgb(canvas, out_path)
    print(f"\nSaved {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print('Usage: compose_panel.py <panel> "<widget1>[,widget2,...]|-" <out.png> [bg.png]')
        print('  Pass "-" or "" for the widget list to render the panel chrome only.')
        sys.exit(1)
    panel = sys.argv[1]
    widget_arg = sys.argv[2]
    widgets = [w for w in widget_arg.split(",") if w and w != "-"]
    out = Path(sys.argv[3])
    bg = Path(sys.argv[4]) if len(sys.argv) > 4 else None
    compose_panel(panel, widgets, bg, out)
