#!/usr/bin/env python3
"""Extract the TrialsClockFont TMP sprite atlas (digit + colon glyphs).

The trial debate scene's timer label renders ``<sprite name="0">...`` tags
that look up entries in a TMP_SpriteAsset called ``TrialsClockFont``, not
ordinary font glyphs. The sprite asset ships in
``general-fonts-common_assets_all.bundle`` alongside other small fonts
shared across the game. This script walks the bundle, locates the
TrialsClockFont MonoBehaviour + its 11 referenced Sprite objects (digits
0-9 plus colon), and emits PNGs + a meta file the renderer can plug into
the same path as ``scene/trial/<sprite>.png``.

Output layout::

    scene/trial/digits/
      meta.json
      0.png  1.png  ...  9.png  colon.png

Each PNG is padded to the sprite's full ``m_Rect`` (64x64 here) so the
TMP glyph metrics (bearing, advance) reference the saved image's
coordinate system directly without any per-sprite cropping math at
render time. Re-anchoring uses the same vertex-bbox trick as
``extract_diced_atlas.py``.

``meta.json`` schema (one entry per glyph)::

    {
      "atlas": "TrialsClockFont",
      "atlas_native_em": 64,            # px per font_size unit when rendering
      "sprites": [
        {
          "tag":      "0",              # name used by <sprite name="X"> tags
          "file":     "0.png",          # relative to the meta.json file
          "rect":     [W, H],           # PNG dimensions (= m_Rect)
          "metrics": {
            "width":            64.0,
            "height":           64.0,
            "horizontalBearingX": -8.0,
            "horizontalBearingY": 56.0,
            "horizontalAdvance":  44.0
          },
          "scale":    1.0               # m_Scale from the character table
        },
        ...
      ]
    }

Usage::

    python3 scripts/extract_trial_digits.py <out_dir> <bundle>
    # Typical:
    python3 scripts/extract_trial_digits.py scene/trial/digits \
        <…>/general-fonts-common_assets_all.bundle

Re-runnable; overwrites existing files.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import UnityPy
from PIL import Image
from UnityPy.helpers.MeshHelper import MeshHandler

ATLAS_NAME = "TrialsClockFont"
# Filesystem-safe basename per sprite tag (`:` is fine on Linux/macOS but
# annoying in URLs and forbidden on Windows). The renderer reads this map
# from meta.json — no need to embed the same convention in the renderer.
_SAFE_BASENAME = {":": "colon"}


def _safe_basename(tag: str) -> str:
    return _SAFE_BASENAME.get(tag, tag)


def _vertex_bbox_local_pixels(sp) -> tuple[float, float, float, float]:
    """Mesh vertex bbox in **local sprite pixels** (Y-up, pivot-centred).

    For non-diced sprites the mesh vertices live in the sprite's local frame
    — origin at the sprite's pivot, not in the atlas. The diced extractor's
    world-coord version doesn't apply here.
    """
    mesh = MeshHandler(sp.m_RD, sp.object_reader.version)
    mesh.process()
    positions = mesh.m_Vertices
    if not positions:
        raise ValueError(f"Sprite {sp.m_Name!r}: no mesh vertices")
    ptu = sp.m_PixelsToUnits
    xs = [p[0] * ptu for p in positions]
    ys = [p[1] * ptu for p in positions]
    return (min(xs), min(ys), max(xs), max(ys))


def _pad_to_rect(img: Image.Image, sp) -> Image.Image:
    """Pad bbox-cropped reconstruction to the full m_Rect using the sprite's
    pivot to place the image.

    Convention: pivot ∈ [0..1] of m_Rect; vertex bbox is in local pixels
    centred on the pivot. The image left edge maps to ``pivot_x_in_rect_px +
    local_x_min``; the image top (PIL Y-down) maps to ``pivot_y_in_rect_px -
    local_y_max``.
    """
    rect = sp.m_Rect
    canvas_w = int(round(rect.width))
    canvas_h = int(round(rect.height))
    pivot_x_px = sp.m_Pivot.x * rect.width
    pivot_y_px = sp.m_Pivot.y * rect.height  # Unity Y-up within rect
    x_min, _, _, y_max = _vertex_bbox_local_pixels(sp)
    pad_left = int(round(pivot_x_px + x_min))
    pad_top  = int(round(pivot_y_px - y_max))  # PIL Y-down: invert via (pivot - local_y_max)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    canvas.paste(img, (pad_left, pad_top))
    return canvas


def extract(bundle_path: str, out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    env = UnityPy.load(bundle_path)

    sprite_obj_by_pid: dict[int, object] = {}
    behaviour_tree: dict | None = None
    # Walk every object: must not break early because MonoBehaviour and Sprite
    # objects are interleaved in the bundle's iteration order, and short-
    # circuiting on the first matching MonoBehaviour would leave later Sprite
    # objects unregistered (two of the 11 digits in the wild).
    for obj in env.objects:
        if obj.type.name == "Sprite":
            sprite_obj_by_pid[obj.path_id] = obj
        elif obj.type.name == "MonoBehaviour":
            try:
                d = obj.read()
                if getattr(d, "m_Name", "") != ATLAS_NAME:
                    continue
                tree = obj.read_typetree()
                if "m_SpriteCharacterTable" in tree and "m_GlyphTable" in tree:
                    behaviour_tree = tree
            except Exception:
                continue

    if behaviour_tree is None:
        raise SystemExit(
            f"No MonoBehaviour named {ATLAS_NAME!r} with TMP sprite tables "
            f"found in {bundle_path}"
        )

    glyphs_by_index: dict[int, dict] = {
        g["m_Index"]: g for g in behaviour_tree["m_GlyphTable"]
    }

    sprites_meta: list[dict] = []
    for entry in behaviour_tree["m_SpriteCharacterTable"]:
        tag = entry.get("m_Name", "")
        gidx = entry.get("m_GlyphIndex")
        glyph = glyphs_by_index.get(gidx)
        if glyph is None:
            print(f"  ! tag {tag!r}: missing glyph index {gidx}", file=sys.stderr)
            continue
        spref = glyph.get("sprite", {})
        pid = spref.get("m_PathID")
        obj = sprite_obj_by_pid.get(pid)
        if obj is None:
            print(f"  ! tag {tag!r}: missing sprite path_id {pid}", file=sys.stderr)
            continue
        sp = obj.read()
        img = sp.image
        padded = _pad_to_rect(img, sp)

        fname = f"{_safe_basename(tag)}.png"
        padded.save(out / fname)

        metrics = glyph["m_Metrics"]
        sprites_meta.append({
            "tag":     tag,
            "file":    fname,
            "rect":    [padded.width, padded.height],
            "metrics": {
                "width":              float(metrics["m_Width"]),
                "height":             float(metrics["m_Height"]),
                "horizontalBearingX": float(metrics["m_HorizontalBearingX"]),
                "horizontalBearingY": float(metrics["m_HorizontalBearingY"]),
                "horizontalAdvance":  float(metrics["m_HorizontalAdvance"]),
            },
            "scale":   float(entry.get("m_Scale", 1.0)),
        })

    # Stable order: digits 0-9 first, then everything else by tag.
    sprites_meta.sort(key=lambda s: (0, int(s["tag"])) if s["tag"].isdigit() else (1, s["tag"]))

    # Native em — the pixel height the glyph metrics are expressed in. Used by
    # the renderer to scale "pixels-per-metric-unit" = font_size / atlas_native_em.
    # For TMP sprite assets with empty FaceInfo, this is the m_Rect / glyph
    # rect height (64 here).
    atlas_native_em = sprites_meta[0]["rect"][1] if sprites_meta else 64

    meta = {
        "atlas":           ATLAS_NAME,
        "atlas_native_em": atlas_native_em,
        "sprites":         sprites_meta,
    }
    (out / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n"
    )

    print(f"# Extracted {len(sprites_meta)} glyphs from {bundle_path}")
    print(f"  atlas:           {ATLAS_NAME}")
    print(f"  atlas_native_em: {atlas_native_em}")
    print(f"  out_dir:         {out}")
    print(f"  tags:            {[s['tag'] for s in sprites_meta]}")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    out_dir, bundle = argv[1], argv[2]
    extract(bundle, out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
